-- Correcciones al calculo de puntualidad, encontradas contrastando contra marcas reales:
--
-- 1. La jornada del turno 2 CRUZA LA MEDIANOCHE. Ej. vehiculo 729 del 2026-07-21:
--    INICIA 05:40 | INICIA 2 16:00 | HORA FIN 02:00 (del dia siguiente).
--    Restar dos `time` daba diferencias de +/-1440 min (24 h) en vez de unos pocos min.
--
-- 2. Por lo mismo, una SALIDA marcada a las 02:13 pertenece a la programacion del
--    DIA ANTERIOR, no a la del dia en que quedo registrada.
--
-- Se resuelve guardando marcas de tiempo completas (fecha + hora) en el cache y
-- comparando timestamps, no horas sueltas.
--
-- 3. Criterio de falta segun el sentido:
--      ENTRADA -> la falta es llegar TARDE. Llegar antes es normal (mediana del
--                 turno 1: 15 min antes) y no se cuenta como incumplimiento.
--      SALIDA  -> la falta es irse ANTES de la hora fin. Salir despues es sobretiempo.

alter table public.programacion_turnos
  add column if not exists entrada_ts timestamp,
  add column if not exists salida_ts timestamp;

create index if not exists idx_programacion_turnos_dni_entrada
  on public.programacion_turnos (dni, entrada_ts);
create index if not exists idx_programacion_turnos_dni_salida
  on public.programacion_turnos (dni, salida_ts);

alter table public.asistencias
  add column if not exists fecha_programada date;

comment on column public.asistencias.fecha_programada is
  'Dia de la programacion al que pertenece la marca. Puede ser el dia anterior cuando la jornada cruza la medianoche.';

-- Refresco del cache, ahora calculando los timestamps de inicio y fin.
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
    (fecha, dni, turno, hora_entrada, hora_salida, vehiculo, base, puesto,
     nombre_programacion, entrada_ts, salida_ts)
  select v.fecha, v.dni, v.turno, v.hora_entrada, v.hora_salida,
         v.vehiculo, v.base, v.puesto, v.nombre_programacion,
         (v.fecha + v.hora_entrada)::timestamp,
         -- Si la hora fin es menor que la de inicio, la jornada termina al dia siguiente.
         case when v.hora_salida is null then null
              when v.hora_entrada is not null and v.hora_salida < v.hora_entrada
                then (v.fecha + 1 + v.hora_salida)::timestamp
              else (v.fecha + v.hora_salida)::timestamp end
    from public.v_programacion_conductor v
   where p_fechas is null or v.fecha = any(p_fechas);

  get diagnostics v_filas = row_count;
  return v_filas;
end;
$function$;

-- Cambia el tipo de retorno (agrega fecha_programada y minutos), hay que soltarla.
drop function if exists public.programacion_de_marca(text, date, time, text);

-- Busca el turno programado que corresponde a una marca, comparando timestamps.
-- Mira el dia de la marca y el anterior (por las jornadas que cruzan medianoche)
-- y descarta lo que quede a mas de 6 horas: eso ya no es la misma jornada.
create or replace function public.programacion_de_marca(
  p_dni text, p_fecha date, p_hora time, p_sentido text
)
returns table (
  turno smallint, hora_programada time, vehiculo text, base text, puesto text,
  fecha_programada date, minutos integer
)
language sql
stable
security definer
set search_path = public
as $function$
  with marca as (
    select (p_fecha + p_hora)::timestamp as ts,
           regexp_replace(coalesce(p_dni, ''), '[^0-9]', '', 'g') as dni
  )
  select t.turno,
         case when p_sentido = 'salida' then t.hora_salida else t.hora_entrada end,
         t.vehiculo, t.base, t.puesto, t.fecha,
         round(extract(epoch from (m.ts - objetivo.ts)) / 60.0)::integer
    from public.programacion_turnos t
    cross join marca m
    cross join lateral (
      select (case when p_sentido = 'salida' then t.salida_ts else t.entrada_ts end) as ts
    ) objetivo
   where t.dni = m.dni
     and t.fecha between p_fecha - 1 and p_fecha
     and objetivo.ts is not null
     and abs(extract(epoch from (m.ts - objetivo.ts))) <= 6 * 3600
   order by abs(extract(epoch from (m.ts - objetivo.ts)))
   limit 1;
$function$;

create or replace function public.calcular_puntualidad_asistencia()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_dni text;
  v_prog record;
begin
  new.hora_programada := null;
  new.vehiculo_programado := null;
  new.turno_programado := null;
  new.minutos_diferencia := null;
  new.fecha_programada := null;
  new.puntualidad := 'sin_programacion';

  select c.dni into v_dni from public.colaboradores c where c.id = new.colaborador_id;
  if v_dni is null then
    return new;
  end if;

  select * into v_prog
    from public.programacion_de_marca(v_dni, new.fecha, new.hora, new.sentido);

  if v_prog.hora_programada is null then
    return new;
  end if;

  new.hora_programada := v_prog.hora_programada;
  new.vehiculo_programado := v_prog.vehiculo;
  new.turno_programado := v_prog.turno;
  new.fecha_programada := v_prog.fecha_programada;
  new.minutos_diferencia := v_prog.minutos;

  -- En la entrada la falta es llegar tarde; en la salida, irse antes.
  new.puntualidad := case
    when new.sentido = 'salida' then
      case when v_prog.minutos < -15 then 'temprano' else 'a_tiempo' end
    else
      case when v_prog.minutos > 15 then 'tarde'
           when v_prog.minutos < -15 then 'temprano'
           else 'a_tiempo' end
  end;

  return new;
exception when others then
  return new;
end;
$function$;

-- Reporte sentido-consciente: cuenta como falta la entrada tarde y la salida temprana.
create or replace function public.reporte_puntualidad(
  p_desde date,
  p_hasta date,
  p_tolerancia integer default 15
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_detalle jsonb;
  v_resumen jsonb;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  with faltas as (
    select a.id, a.fecha, a.hora, a.sentido, a.hora_programada, a.minutos_diferencia,
           a.turno_programado, a.vehiculo_reporte, a.vehiculo_programado, c.dni, c.nombre,
           case when a.sentido = 'salida' then 'salida_temprana' else 'entrada_tarde' end as tipo,
           case when a.sentido = 'salida' then -a.minutos_diferencia else a.minutos_diferencia end as minutos_falta
      from public.asistencias a
      join public.colaboradores c on c.id = a.colaborador_id
     where a.fecha between p_desde and p_hasta
       and a.minutos_diferencia is not null
       and case when a.sentido = 'salida'
                then a.minutos_diferencia < -p_tolerancia
                else a.minutos_diferencia > p_tolerancia end
  )
  select jsonb_agg(jsonb_build_object(
           'id', id, 'fecha', fecha, 'hora', to_char(hora, 'HH24:MI'), 'sentido', sentido,
           'dni', dni, 'nombre', nombre, 'tipo', tipo,
           'hora_programada', to_char(hora_programada, 'HH24:MI'),
           'minutos', minutos_falta, 'turno', turno_programado,
           'vehiculo', vehiculo_reporte, 'vehiculo_programado', vehiculo_programado
         ) order by fecha desc, hora desc)
    into v_detalle from faltas;

  with base as (
    select c.dni, c.nombre, a.sentido, a.minutos_diferencia
      from public.asistencias a
      join public.colaboradores c on c.id = a.colaborador_id
     where a.fecha between p_desde and p_hasta and a.minutos_diferencia is not null
  )
  select jsonb_agg(r order by (r->>'faltas')::int desc, (r->>'minutos_total')::int desc)
    into v_resumen
  from (
    select jsonb_build_object(
      'dni', dni, 'nombre', nombre,
      'marcas', count(*),
      'entrada_tarde', count(*) filter (where sentido <> 'salida' and minutos_diferencia > p_tolerancia),
      'salida_temprana', count(*) filter (where sentido = 'salida' and minutos_diferencia < -p_tolerancia),
      'faltas', count(*) filter (where case when sentido = 'salida'
                                            then minutos_diferencia < -p_tolerancia
                                            else minutos_diferencia > p_tolerancia end),
      'minutos_total', coalesce(sum(case when sentido = 'salida'
                                         then -minutos_diferencia else minutos_diferencia end)
                        filter (where case when sentido = 'salida'
                                           then minutos_diferencia < -p_tolerancia
                                           else minutos_diferencia > p_tolerancia end), 0),
      'peor', coalesce(max(case when sentido = 'salida'
                                then -minutos_diferencia else minutos_diferencia end)
               filter (where case when sentido = 'salida'
                                  then minutos_diferencia < -p_tolerancia
                                  else minutos_diferencia > p_tolerancia end), 0)
    ) as r
    from base
    group by dni, nombre
    having count(*) filter (where case when sentido = 'salida'
                                       then minutos_diferencia < -p_tolerancia
                                       else minutos_diferencia > p_tolerancia end) > 0
  ) y;

  return jsonb_build_object(
    'ok', true, 'desde', p_desde, 'hasta', p_hasta, 'tolerancia', p_tolerancia,
    'resumen', coalesce(v_resumen, '[]'::jsonb),
    'detalle', coalesce(v_detalle, '[]'::jsonb)
  );
end;
$function$;

grant execute on function public.programacion_de_marca(text, date, time, text) to authenticated;
