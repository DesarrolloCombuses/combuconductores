-- La vista v_programacion_conductor tarda ~1.2 s por consulta (recorre las 5.900+
-- filas de programacion_filas y normaliza nombres). Eso es inaceptable dentro del
-- trigger que corre en CADA marca, asi que se materializa en una tabla indexada
-- que se refresca sola cuando cambia la programacion.

create table if not exists public.programacion_turnos (
  id bigserial primary key,
  fecha date not null,
  dni text not null,
  turno smallint not null,
  hora_entrada time,
  hora_salida time,
  vehiculo text,
  base text,
  puesto text,
  nombre_programacion text,
  actualizado_en timestamptz not null default now()
);

create index if not exists idx_programacion_turnos_dni_fecha
  on public.programacion_turnos (dni, fecha);
create index if not exists idx_programacion_turnos_fecha
  on public.programacion_turnos (fecha);

alter table public.programacion_turnos enable row level security;
drop policy if exists "programacion_turnos_select_auth" on public.programacion_turnos;
create policy "programacion_turnos_select_auth" on public.programacion_turnos
  for select to authenticated using (true);

-- Reconstruye el cache. Sin argumento reconstruye todo; con fechas, solo esas.
create or replace function public.refrescar_programacion_turnos(p_fechas date[] default null)
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_filas int;
begin
  if p_fechas is null then
    delete from public.programacion_turnos;
  else
    delete from public.programacion_turnos where fecha = any(p_fechas);
  end if;

  insert into public.programacion_turnos
    (fecha, dni, turno, hora_entrada, hora_salida, vehiculo, base, puesto, nombre_programacion)
  select v.fecha, v.dni, v.turno, v.hora_entrada, v.hora_salida,
         v.vehiculo, v.base, v.puesto, v.nombre_programacion
    from public.v_programacion_conductor v
   where p_fechas is null or v.fecha = any(p_fechas);

  get diagnostics v_filas = row_count;
  return v_filas;
end;
$function$;

-- Refresco automatico: solo las fechas tocadas, a nivel de sentencia (no por fila),
-- para que una carga masiva de programacion no dispare cientos de reconstrucciones.
create or replace function public.trg_refrescar_turnos_ins()
returns trigger language plpgsql security definer set search_path = public as $function$
declare v_f date[];
begin
  select array_agg(distinct fecha) into v_f from nuevas where fecha is not null;
  if v_f is not null then perform public.refrescar_programacion_turnos(v_f); end if;
  return null;
end; $function$;

create or replace function public.trg_refrescar_turnos_upd()
returns trigger language plpgsql security definer set search_path = public as $function$
declare v_f date[];
begin
  select array_agg(distinct f) into v_f
    from (select fecha as f from nuevas union select fecha from viejas) t where f is not null;
  if v_f is not null then perform public.refrescar_programacion_turnos(v_f); end if;
  return null;
end; $function$;

create or replace function public.trg_refrescar_turnos_del()
returns trigger language plpgsql security definer set search_path = public as $function$
declare v_f date[];
begin
  select array_agg(distinct fecha) into v_f from viejas where fecha is not null;
  if v_f is not null then perform public.refrescar_programacion_turnos(v_f); end if;
  return null;
end; $function$;

drop trigger if exists trg_programacion_filas_cache_ins on public.programacion_filas;
create trigger trg_programacion_filas_cache_ins
  after insert on public.programacion_filas
  referencing new table as nuevas
  for each statement execute function public.trg_refrescar_turnos_ins();

drop trigger if exists trg_programacion_filas_cache_upd on public.programacion_filas;
create trigger trg_programacion_filas_cache_upd
  after update on public.programacion_filas
  referencing new table as nuevas old table as viejas
  for each statement execute function public.trg_refrescar_turnos_upd();

drop trigger if exists trg_programacion_filas_cache_del on public.programacion_filas;
create trigger trg_programacion_filas_cache_del
  after delete on public.programacion_filas
  referencing old table as viejas
  for each statement execute function public.trg_refrescar_turnos_del();

-- Cuando se resuelve/corrige un nombre -> cedula, el cache tambien cambia.
create or replace function public.trg_refrescar_turnos_puente()
returns trigger language plpgsql security definer set search_path = public as $function$
begin
  perform public.refrescar_programacion_turnos(null);
  return null;
end; $function$;

drop trigger if exists trg_puente_cache on public.programacion_conductor_dni;
create trigger trg_puente_cache
  after insert or update of dni or delete on public.programacion_conductor_dni
  for each statement execute function public.trg_refrescar_turnos_puente();

-- Ahora la consulta por marca es un index scan, no un recorrido completo.
create or replace function public.programacion_de_marca(
  p_dni text, p_fecha date, p_hora time, p_sentido text
)
returns table (
  turno smallint, hora_programada time, vehiculo text, base text, puesto text
)
language sql
stable
security definer
set search_path = public
as $function$
  select t.turno,
         case when p_sentido = 'salida' then t.hora_salida else t.hora_entrada end,
         t.vehiculo, t.base, t.puesto
    from public.programacion_turnos t
   where t.dni = regexp_replace(coalesce(p_dni, ''), '[^0-9]', '', 'g')
     and t.fecha = p_fecha
     and (case when p_sentido = 'salida' then t.hora_salida else t.hora_entrada end) is not null
   order by abs(extract(epoch from (
              p_hora - (case when p_sentido = 'salida' then t.hora_salida else t.hora_entrada end))))
   limit 1;
$function$;

-- La app tambien lee del cache.
create or replace function public.obtener_programacion_dia(p_dni text, p_fecha date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_dni text;
  v_turnos jsonb;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  v_dni := regexp_replace(coalesce(p_dni, ''), '[^0-9]', '', 'g');
  if v_dni = '' then
    return jsonb_build_object('ok', false, 'error', 'Cedula vacia.');
  end if;

  select jsonb_agg(jsonb_build_object(
           'turno', t.turno,
           'hora_entrada', to_char(t.hora_entrada, 'HH24:MI'),
           'hora_salida', to_char(t.hora_salida, 'HH24:MI'),
           'vehiculo', t.vehiculo,
           'base', t.base,
           'puesto', t.puesto
         ) order by t.hora_entrada)
    into v_turnos
    from public.programacion_turnos t
   where t.dni = v_dni and t.fecha = p_fecha;

  return jsonb_build_object(
    'ok', true,
    'existe', v_turnos is not null,
    'fecha', p_fecha,
    'turnos', coalesce(v_turnos, '[]'::jsonb)
  );
end;
$function$;

grant execute on function public.refrescar_programacion_turnos(date[]) to authenticated;
