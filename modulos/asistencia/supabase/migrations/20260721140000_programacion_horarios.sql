-- Cruce entre la programacion de turnos (programacion_filas) y el biometrico.
-- La programacion NO trae cedula, solo el nombre del conductor, asi que se resuelve
-- nombre -> dni en una tabla puente revisable a mano (programacion_conductor_dni).
--
-- Estructura de programacion_filas.row_data:
--   FECHA, VEH, BASE, PUESTO, INICIA, INICIA 2, HORA FIN, CONDUCTOR 1, CONDUCTOR 2
-- Cada vehiculo tiene 2 turnos encadenados:
--   CONDUCTOR 1: entrada = INICIA    salida = INICIA 2
--   CONDUCTOR 2: entrada = INICIA 2  salida = HORA FIN

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Normalizadores de nombre
-- ---------------------------------------------------------------------------

-- Quita tildes, signos y espacios de mas. "José  Pérez-Gómez" -> "JOSE PEREZ GOMEZ"
create or replace function public.normalizar_nombre(p_texto text)
returns text
language sql
immutable
as $function$
  select nullif(
    trim(regexp_replace(
      regexp_replace(
        upper(translate(coalesce(p_texto, ''),
          'ÁÉÍÓÚÜÑáéíóúüñÀÈÌÒÙàèìòù',
          'AEIOUUNAEIOUUNAEIOUAEIOU')),
        '[^A-Z0-9]', ' ', 'g'),
      '\s+', ' ', 'g')),
    '')
$function$;

-- Igual pero con las palabras ordenadas, para que "JUAN TOVAR" y "TOVAR JUAN" cuadren.
create or replace function public.normalizar_nombre_tokens(p_texto text)
returns text
language sql
immutable
as $function$
  select nullif(array_to_string(
    array(select w from unnest(string_to_array(public.normalizar_nombre(p_texto), ' ')) w order by w),
    ' '), '')
$function$;

-- 'HH:MM' o 'H:MM' -> time. Devuelve null si viene vacio o mal escrito.
create or replace function public.hora_programada_a_time(p_texto text)
returns time
language plpgsql
immutable
as $function$
declare
  v text := trim(coalesce(p_texto, ''));
begin
  if v !~ '^[0-9]{1,2}:[0-9]{2}$' then
    return null;
  end if;
  return v::time;
exception when others then
  return null;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Tabla puente nombre de la programacion -> cedula
-- ---------------------------------------------------------------------------

create table if not exists public.programacion_conductor_dni (
  nombre_norm text primary key,
  nombre_programacion text not null,
  dni text,
  nombre_colaborador text,
  metodo text,                       -- exacto | orden | parecido | manual | ignorado | sin_cruce
  similitud numeric,
  revisado boolean not null default false,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create index if not exists idx_programacion_conductor_dni_dni
  on public.programacion_conductor_dni (dni);

alter table public.programacion_conductor_dni enable row level security;

drop policy if exists "pcd_select_auth" on public.programacion_conductor_dni;
create policy "pcd_select_auth" on public.programacion_conductor_dni
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Resolucion automatica: exacto -> orden distinto -> parecido
-- ---------------------------------------------------------------------------

create or replace function public.resolver_nombres_programacion(
  p_umbral numeric default 0.80,
  p_margen numeric default 0.08
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_nuevos int := 0;
  v_exacto int := 0;
  v_orden int := 0;
  v_parecido int := 0;
  v_ignorado int := 0;
  v_pendientes int := 0;
begin
  -- 1. Alimenta la tabla puente con los nombres que aparecen en la programacion.
  with nombres as (
    select distinct trim(x) as nombre
    from (
      select row_data->>'CONDUCTOR 1' as x from public.programacion_filas
      union all
      select row_data->>'CONDUCTOR 2' from public.programacion_filas
    ) t
    where public.normalizar_nombre(x) is not null
  )
  insert into public.programacion_conductor_dni (nombre_norm, nombre_programacion)
  select public.normalizar_nombre(nombre), nombre from nombres
  on conflict (nombre_norm) do nothing;
  get diagnostics v_nuevos = row_count;

  -- 2. Marca los que no son personas ("SIN CONDUCTOR PROGRAMADO", una sola palabra...).
  update public.programacion_conductor_dni
     set metodo = 'ignorado', revisado = true, actualizado_en = now()
   where dni is null and not revisado
     and (nombre_norm like '%SIN CONDUCTOR%'
          or nombre_norm like '%SIN PROGRAMAR%'
          or array_length(string_to_array(nombre_norm, ' '), 1) < 2);
  get diagnostics v_ignorado = row_count;

  -- 3. Cruce exacto.
  update public.programacion_conductor_dni p
     set dni = c.dni, nombre_colaborador = c.nombre, metodo = 'exacto',
         similitud = 1, actualizado_en = now()
    from public.colaboradores c
   where p.dni is null and not p.revisado
     and public.normalizar_nombre(c.nombre) = p.nombre_norm
     and (select count(*) from public.colaboradores c2
           where public.normalizar_nombre(c2.nombre) = p.nombre_norm) = 1;
  get diagnostics v_exacto = row_count;

  -- 4. Mismo nombre con las palabras en otro orden.
  update public.programacion_conductor_dni p
     set dni = c.dni, nombre_colaborador = c.nombre, metodo = 'orden',
         similitud = 1, actualizado_en = now()
    from public.colaboradores c
   where p.dni is null and not p.revisado
     and public.normalizar_nombre_tokens(c.nombre) = public.normalizar_nombre_tokens(p.nombre_norm)
     and (select count(*) from public.colaboradores c2
           where public.normalizar_nombre_tokens(c2.nombre)
               = public.normalizar_nombre_tokens(p.nombre_norm)) = 1;
  get diagnostics v_orden = row_count;

  -- 5. Parecido (errores de digitacion). Solo si el mejor candidato pasa el umbral
  --    Y le saca ventaja clara al segundo, para no asignar una cedula equivocada.
  update public.programacion_conductor_dni p
     set dni = m.dni, nombre_colaborador = m.nombre, metodo = 'parecido',
         similitud = round(m.sim::numeric, 3), actualizado_en = now()
    from (
      select x.nombre_norm, x.dni, x.nombre, x.sim
      from (
        select p2.nombre_norm, c.dni, c.nombre,
               similarity(public.normalizar_nombre_tokens(p2.nombre_norm),
                          public.normalizar_nombre_tokens(c.nombre)) as sim,
               row_number() over (partition by p2.nombre_norm order by
                 similarity(public.normalizar_nombre_tokens(p2.nombre_norm),
                            public.normalizar_nombre_tokens(c.nombre)) desc) as rn,
               lead(similarity(public.normalizar_nombre_tokens(p2.nombre_norm),
                               public.normalizar_nombre_tokens(c.nombre))) over (
                 partition by p2.nombre_norm order by
                 similarity(public.normalizar_nombre_tokens(p2.nombre_norm),
                            public.normalizar_nombre_tokens(c.nombre)) desc) as sim2
        from public.programacion_conductor_dni p2
        cross join public.colaboradores c
        where p2.dni is null and not p2.revisado
      ) x
      where x.rn = 1 and x.sim >= p_umbral
        and (x.sim2 is null or x.sim - x.sim2 >= p_margen)
    ) m
   where p.nombre_norm = m.nombre_norm and p.dni is null and not p.revisado;
  get diagnostics v_parecido = row_count;

  -- 6. Los que quedaron sin cruce se marcan para revision manual.
  update public.programacion_conductor_dni
     set metodo = 'sin_cruce', actualizado_en = now()
   where dni is null and not revisado and coalesce(metodo, '') <> 'sin_cruce';

  select count(*) into v_pendientes
    from public.programacion_conductor_dni where dni is null and not revisado;

  return jsonb_build_object(
    'ok', true, 'nombres_nuevos', v_nuevos, 'exacto', v_exacto, 'orden', v_orden,
    'parecido', v_parecido, 'ignorado', v_ignorado, 'sin_resolver', v_pendientes
  );
end;
$function$;

-- Asignacion manual desde el panel de administracion.
create or replace function public.asignar_dni_programacion(p_nombre_norm text, p_dni text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_nombre text;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  if coalesce(trim(p_dni), '') = '' then
    update public.programacion_conductor_dni
       set dni = null, nombre_colaborador = null, metodo = 'ignorado',
           revisado = true, actualizado_en = now()
     where nombre_norm = p_nombre_norm;
    return jsonb_build_object('ok', true, 'dni', null);
  end if;

  select nombre into v_nombre from public.colaboradores
   where dni = regexp_replace(p_dni, '[^0-9]', '', 'g');
  if v_nombre is null then
    return jsonb_build_object('ok', false, 'error', 'Esa cedula no existe en colaboradores.');
  end if;

  update public.programacion_conductor_dni
     set dni = regexp_replace(p_dni, '[^0-9]', '', 'g'),
         nombre_colaborador = v_nombre, metodo = 'manual',
         similitud = null, revisado = true, actualizado_en = now()
   where nombre_norm = p_nombre_norm;

  return jsonb_build_object('ok', true, 'dni', regexp_replace(p_dni, '[^0-9]', '', 'g'), 'nombre', v_nombre);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Vistas: un turno por conductor
-- ---------------------------------------------------------------------------

create or replace view public.v_programacion_turnos as
with base as (
  select
    f.fecha,
    coalesce(nullif(trim(f.vehiculo), ''), nullif(trim(f.row_data->>'VEH'), '')) as vehiculo,
    coalesce(nullif(trim(f.base), ''), nullif(trim(f.row_data->>'BASE'), '')) as base,
    nullif(trim(f.row_data->>'PUESTO'), '') as puesto,
    public.hora_programada_a_time(f.row_data->>'INICIA') as ini1,
    public.hora_programada_a_time(f.row_data->>'INICIA 2') as ini2,
    public.hora_programada_a_time(f.row_data->>'HORA FIN') as fin,
    nullif(trim(f.row_data->>'CONDUCTOR 1'), '') as c1,
    nullif(trim(f.row_data->>'CONDUCTOR 2'), '') as c2
  from public.programacion_filas f
  where f.fecha is not null
)
select fecha, 1::smallint as turno, c1 as nombre_programacion,
       ini1 as hora_entrada, ini2 as hora_salida, vehiculo, base, puesto
  from base where c1 is not null and ini1 is not null
union all
select fecha, 2::smallint, c2, ini2, fin, vehiculo, base, puesto
  from base where c2 is not null and ini2 is not null;

create or replace view public.v_programacion_conductor as
select t.fecha, p.dni, p.nombre_colaborador, t.turno, t.hora_entrada, t.hora_salida,
       t.vehiculo, t.base, t.puesto, t.nombre_programacion
  from public.v_programacion_turnos t
  join public.programacion_conductor_dni p
    on p.nombre_norm = public.normalizar_nombre(t.nombre_programacion)
 where p.dni is not null;

grant select on public.v_programacion_turnos to authenticated;
grant select on public.v_programacion_conductor to authenticated;

-- ---------------------------------------------------------------------------
-- RPC que consume la app al validar la cedula
-- ---------------------------------------------------------------------------

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
           'turno', v.turno,
           'hora_entrada', to_char(v.hora_entrada, 'HH24:MI'),
           'hora_salida', to_char(v.hora_salida, 'HH24:MI'),
           'vehiculo', v.vehiculo,
           'base', v.base,
           'puesto', v.puesto
         ) order by v.hora_entrada)
    into v_turnos
    from public.v_programacion_conductor v
   where v.dni = v_dni and v.fecha = p_fecha;

  return jsonb_build_object(
    'ok', true,
    'existe', v_turnos is not null,
    'fecha', p_fecha,
    'turnos', coalesce(v_turnos, '[]'::jsonb)
  );
end;
$function$;

grant execute on function public.resolver_nombres_programacion(numeric, numeric) to authenticated;
grant execute on function public.asignar_dni_programacion(text, text) to authenticated;
grant execute on function public.obtener_programacion_dia(text, date) to authenticated;
