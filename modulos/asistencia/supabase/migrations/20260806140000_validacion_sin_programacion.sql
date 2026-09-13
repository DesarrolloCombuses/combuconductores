-- Validacion de entradas/salidas del personal SIN programacion de turnos
-- (gestores de servicio, gestores de movilidad, auxiliares de control...).
--
-- A ellos no se les puede comparar contra un horario: no tienen programacion y su
-- hora de entrada rota muchisimo (dispersion medida de 300-490 min; hay quien entra
-- entre las 00:04 y las 23:49). Tampoco sirve su propio patron historico.
--
-- Lo que SI es estable es la DURACION de la jornada. El histograma sobre 1.136
-- jornadas muestra DOS turnos legitimos, no uno:
--    6-8 h   107 | 8-10 h  798  <- turno diurno (mediana 8,7 h)
--   10-12 h   32 | 12-13 h   3  | 13-14 h  5   <- valle
--   14-15 h   56 | 15-16 h  44  <- turno nocturno, tambien legitimo
--   16-18 h    7 | 18-24 h  12  | >24 h   49   <- aqui si son errores
-- Por eso el corte NO puede ir en 12 h (marcaria como error 100 jornadas nocturnas
-- buenas): va en 18 h, despues de la cola del turno nocturno. De las 61 jornadas que
-- quedan por encima, 49 pasan de 24 h, o sea cierres claramente olvidados.
--
-- Por eso la validacion aqui es ESTRUCTURAL, no de horario:
--   sin_cerrar    : entro y no ha cerrado, y ya pasaron mas de 18 h
--   jornada_larga : la jornada duro mas de 18 h (probable cierre olvidado)
--   muy_corta     : menos de 30 min entre entrada y salida (marca doble)

create or replace function public.validacion_sin_programacion(
  p_desde date,
  p_hasta date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_totales jsonb;
  v_resumen jsonb;
  v_detalle jsonb;
  v_horas_max constant numeric := 18;   -- corte medido, tras la cola del turno nocturno
  v_min_corta constant interval := interval '30 minutes';
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  p_desde := greatest(p_desde, public.fecha_corte_verificacion());
  if p_desde > p_hasta then
    return jsonb_build_object('ok', true, 'desde', p_desde, 'hasta', p_hasta,
      'totales', '{}'::jsonb, 'resumen', '[]'::jsonb, 'detalle', '[]'::jsonb);
  end if;

  -- Solo personal que NO tiene programacion de turnos en ninguna fecha.
  create temp table _jor on commit drop as
  with gente as (
    select c.id, c.dni, c.nombre, coalesce(c.especialidad, '') as cargo
      from public.colaboradores c
     where not exists (select 1 from public.programacion_turnos pt where pt.dni = c.dni)
  ),
  marcas as (
    select g.dni, g.nombre, g.cargo, a.id, a.fecha, a.sentido, a.hora,
           (a.fecha + a.hora)::timestamp as ts,
           lead(a.sentido) over w as sig_sent,
           lead((a.fecha + a.hora)::timestamp) over w as sig_ts,
           lead(a.hora) over w as sig_hora,
           lead(a.fecha) over w as sig_fecha,
           lead(a.id) over w as sig_id
      from public.asistencias a
      join gente g on g.id = a.colaborador_id
     where a.fecha between p_desde - 1 and p_hasta + 1
    window w as (partition by a.colaborador_id order by a.fecha, a.hora)
  )
  select dni, nombre, cargo, id as entrada_id, fecha, hora as entrada_hora, ts,
         sig_id as salida_id, sig_fecha as salida_fecha, sig_hora as salida_hora,
         case when sig_sent = 'salida' and sig_ts is not null
              then round(extract(epoch from (sig_ts - ts)) / 3600.0, 2) end as horas,
         case
           when sig_sent is distinct from 'salida' or sig_ts is null then
             case when (now() at time zone 'America/Bogota') - ts > (v_horas_max || ' hours')::interval
                  then 'sin_cerrar' end
           when sig_ts - ts > (v_horas_max || ' hours')::interval then 'jornada_larga'
           when sig_ts - ts < v_min_corta then 'muy_corta'
         end as tipo
    from marcas
   where sentido = 'entrada' and fecha between p_desde and p_hasta;

  select jsonb_build_object(
    'personas', count(distinct dni),
    'jornadas', count(*),
    'con_novedad', count(*) filter (where tipo is not null),
    'sin_cerrar', count(*) filter (where tipo = 'sin_cerrar'),
    'jornada_larga', count(*) filter (where tipo = 'jornada_larga'),
    'muy_corta', count(*) filter (where tipo = 'muy_corta'),
    'duracion_mediana', percentile_disc(0.5) within group (order by horas)
  ) into v_totales from _jor;

  select jsonb_agg(r order by (r->>'novedades')::int desc, r->>'nombre')
    into v_resumen
  from (
    select jsonb_build_object(
      'dni', dni, 'nombre', nombre, 'cargo', cargo,
      'jornadas', count(*),
      'novedades', count(*) filter (where tipo is not null),
      'sin_cerrar', count(*) filter (where tipo = 'sin_cerrar'),
      'jornada_larga', count(*) filter (where tipo = 'jornada_larga'),
      'muy_corta', count(*) filter (where tipo = 'muy_corta'),
      'duracion_promedio', round(avg(horas) filter (where tipo is null), 1),
      'duracion_max', max(horas)
    ) as r
    from _jor group by dni, nombre, cargo
  ) y;

  select jsonb_agg(d order by d->>'fecha' desc, d->>'nombre')
    into v_detalle
  from (
    select jsonb_build_object(
      'fecha', fecha, 'dni', dni, 'nombre', nombre, 'cargo', cargo,
      'tipo', tipo,
      'entrada_id', entrada_id::text,
      'entrada_hora', to_char(entrada_hora, 'HH24:MI'),
      'entrada_fecha', fecha::text,
      'salida_id', salida_id::text,
      'salida_hora', to_char(salida_hora, 'HH24:MI'),
      'salida_fecha', salida_fecha::text,
      'horas', horas
    ) as d
    from _jor where tipo is not null
  ) z;

  return jsonb_build_object(
    'ok', true, 'desde', p_desde, 'hasta', p_hasta,
    'horas_max', v_horas_max,
    'totales', coalesce(v_totales, '{}'::jsonb),
    'resumen', coalesce(v_resumen, '[]'::jsonb),
    'detalle', coalesce(v_detalle, '[]'::jsonb)
  );
end;
$function$;

grant execute on function public.validacion_sin_programacion(date, date) to authenticated;
