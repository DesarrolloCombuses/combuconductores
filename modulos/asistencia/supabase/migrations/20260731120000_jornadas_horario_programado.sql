-- Ampliacion de reporte_jornadas_anomalas: el detalle ahora devuelve la hora
-- programada de INGRESO y de SALIDA por separado (entrada_programada /
-- salida_programada), tomadas de programacion_turnos para ese conductor y dia,
-- eligiendo el turno mas cercano a la marca. Asi el que corrige puede comparar
-- la entrada real contra la programada y la salida real contra la programada.

create or replace function public.reporte_jornadas_anomalas(
  p_desde date,
  p_hasta date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_detalle jsonb;
  v_resumen jsonb;
  v_totales jsonb;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  -- Solo se verifica desde la fecha de corte. Lo anterior no se evalua.
  p_desde := greatest(p_desde, public.fecha_corte_verificacion());
  if p_desde > p_hasta then
    return jsonb_build_object('ok', true, 'desde', p_desde, 'hasta', p_hasta,
      'totales', jsonb_build_object('eventos', 0, 'conductores', 0),
      'resumen', '[]'::jsonb, 'detalle', '[]'::jsonb);
  end if;

  -- Rango ampliado un dia a cada lado para emparejar jornadas que cruzan medianoche.
  create temp table _marks on commit drop as
  select
    a.id, c.dni, c.nombre, a.fecha, a.sentido, a.hora,
    (a.fecha + a.hora)::timestamp as ts,
    a.turno_programado, a.hora_programada, a.fecha_programada, a.minutos_diferencia,
    a.vehiculo_reporte,
    nullif(split_part(coalesce(a.vehiculo_reporte, ''), ' ', 1), '') as veh,
    lag(a.sentido) over w as prev_sent,
    lag((a.fecha + a.hora)::timestamp) over w as prev_ts,
    lead(a.sentido) over w as next_sent,
    lead((a.fecha + a.hora)::timestamp) over w as next_ts,
    lead(a.hora) over w as next_hora,
    lead(a.minutos_diferencia) over w as next_dif,
    lead(a.vehiculo_reporte) over w as next_veh
  from public.asistencias a
  join public.colaboradores c on c.id = a.colaborador_id
  where a.fecha between p_desde - 1 and p_hasta + 1
  window w as (partition by c.dni order by a.fecha, a.hora, a.sentido);

  -- Una fila por "evento anomalo".
  create temp table _anom on commit drop as
  with clasificado as (
    select m.*,
      case
        -- Salida sin una entrada previa que cerrar => sentido invertido / trocado.
        when m.sentido = 'salida'
             and (m.prev_sent is distinct from 'entrada'
                  or m.prev_ts is null
                  or m.ts - m.prev_ts > interval '16 hours')
          then 'sentido_invertido'

        -- Entrada que nunca se cierra (o se cierra >16h despues).
        when m.sentido = 'entrada'
             and (m.next_sent is distinct from 'salida' or m.next_ts is null)
          then 'sin_cerrar'
        when m.sentido = 'entrada' and m.next_sent = 'salida'
             and m.next_ts - m.ts > interval '16 hours'
          then 'jornada_larga'

        -- Jornada valida en secuencia: revisar duracion y encaje con la programacion.
        when m.sentido = 'entrada' and m.next_sent = 'salida'
             and m.next_ts - m.ts < interval '30 minutes'
          then 'muy_corta'

        else null
      end as tipo_base
    from _marks m
    where m.fecha between p_desde and p_hasta
  ),
  -- Para las jornadas normales (entrada->salida entre 30 min y 16 h) se evalua el
  -- encaje con la programacion. Se calcula el turno asignado DIRECTO desde
  -- programacion_turnos (no desde a.turno_programado, que es null cuando la marca
  -- cayo fuera de la ventana de 6 h por trabajar el turno opuesto).
  con_programacion as (
    select c.*,
      round(extract(epoch from (c.next_ts - c.ts)) / 3600.0, 2) as horas,
      asig.turno as asig_turno,
      asig.entrada_ts as asig_ent_ts,
      round(extract(epoch from (c.ts - asig.entrada_ts)) / 60.0)::int as min_ent_asig,
      round(extract(epoch from (c.next_ts - asig.salida_ts)) / 60.0)::int as min_sal_asig,
      otro.dist_min as otro_turno_dif_min
    from clasificado c
    -- Turno propio del conductor ESE dia calendario. Una ENTRADA nunca cruza la
    -- medianoche (solo la salida), asi que se busca en c.fecha; si no tiene turno
    -- ese dia, asig_turno queda null y la jornada no se juzga por horario.
    left join lateral (
      select pt.turno, pt.entrada_ts, pt.salida_ts
        from public.programacion_turnos pt
       where pt.dni = c.dni and pt.fecha = c.fecha
         and pt.entrada_ts is not null
       order by abs(extract(epoch from (c.ts - pt.entrada_ts)))
       limit 1
    ) asig on true
    -- Turno del OTRO conductor del mismo vehiculo ese dia (para detectar el swap).
    left join lateral (
      select min(abs(extract(epoch from (c.ts - pt.entrada_ts)) / 60.0))::int as dist_min
        from public.programacion_turnos pt
       where pt.vehiculo = c.veh and pt.fecha = c.fecha
         and pt.dni is distinct from c.dni and pt.entrada_ts is not null
    ) otro on true
    where c.tipo_base is null
      and c.sentido = 'entrada' and c.next_sent = 'salida'
  ),
  evaluado as (
    select p.*,
      case
        when p.asig_turno is null then null
        -- Trabajo su propio turno: normal.
        when abs(p.min_ent_asig) <= 90 then null
        -- Entrada lejos de su turno pero pegada al otro turno del vehiculo: swap.
        when abs(p.min_ent_asig) > 120
             and p.otro_turno_dif_min is not null
             and p.otro_turno_dif_min <= 90
             and p.otro_turno_dif_min < abs(p.min_ent_asig) - 60
          then 'turno_cambiado'
        -- Entrada y salida corridas +3 h en el mismo sentido: fuera de ventana.
        when abs(p.min_ent_asig) > 180
             and abs(coalesce(p.min_sal_asig, 0)) > 180
             and sign(p.min_ent_asig) = sign(coalesce(p.min_sal_asig, 0))
          then 'fuera_ventana'
        else null
      end as tipo_prog
    from con_programacion p
  )
  select id, dni, nombre, fecha, sentido, hora, ts, turno_programado, hora_programada,
         vehiculo_reporte, next_hora, next_veh, minutos_diferencia, next_dif,
         null::numeric as horas, tipo_base as tipo
    from clasificado where tipo_base is not null
  union all
  select id, dni, nombre, fecha, sentido, hora, ts, asig_turno,
         asig_ent_ts::time, vehiculo_reporte, next_hora, next_veh,
         min_ent_asig, min_sal_asig, horas, tipo_prog as tipo
    from evaluado where tipo_prog is not null;

  -- Solo conductores reales: quienes estan en la programacion en el rango. Esto quita
  -- el ruido del personal de turno nocturno / manual que no maneja vehiculo y cuyo
  -- patron de marcas irregular disparaba falsos "trocado" / "jornada larga".
  delete from _anom
   where dni not in (
     select dni from public.programacion_turnos
      where fecha between p_desde - 1 and p_hasta
   );

  -- Detalle. Se agrega, por cada evento, la hora PROGRAMADA de ingreso y de salida
  -- tomadas del turno mas cercano a la marca ese dia (para poder corregir comparando).
  select jsonb_agg(jsonb_build_object(
           'id', an.id, 'dni', an.dni, 'nombre', an.nombre, 'fecha', an.fecha,
           'tipo', an.tipo,
           'sentido', an.sentido, 'hora', to_char(an.hora, 'HH24:MI'),
           'hora_salida', to_char(an.next_hora, 'HH24:MI'),
           'turno', an.turno_programado,
           'hora_programada', to_char(an.hora_programada, 'HH24:MI'),
           'entrada_programada', to_char(prog.entrada_ts, 'HH24:MI'),
           'salida_programada', to_char(prog.salida_ts, 'HH24:MI'),
           'base', prog.base,
           'vehiculo', an.vehiculo_reporte,
           'horas', an.horas,
           'min_entrada', an.minutos_diferencia, 'min_salida', an.next_dif
         ) order by an.fecha desc, an.hora desc)
    into v_detalle
    from _anom an
    left join lateral (
      select pt.entrada_ts, pt.salida_ts, pt.base
        from public.programacion_turnos pt
       where pt.dni = an.dni and pt.fecha = an.fecha
         and pt.entrada_ts is not null
         and (an.turno_programado is null or pt.turno = an.turno_programado)
       order by abs(extract(epoch from (an.ts - pt.entrada_ts)))
       limit 1
    ) prog on true;

  select jsonb_agg(r order by (r->>'total')::int desc)
    into v_resumen
  from (
    select jsonb_build_object(
      'dni', dni, 'nombre', nombre,
      'total', count(*),
      'sentido_invertido', count(*) filter (where tipo = 'sentido_invertido'),
      'sin_cerrar', count(*) filter (where tipo = 'sin_cerrar'),
      'muy_corta', count(*) filter (where tipo = 'muy_corta'),
      'jornada_larga', count(*) filter (where tipo = 'jornada_larga'),
      'turno_cambiado', count(*) filter (where tipo = 'turno_cambiado'),
      'fuera_ventana', count(*) filter (where tipo = 'fuera_ventana')
    ) as r
    from _anom group by dni, nombre
  ) y;

  select jsonb_build_object(
    'eventos', count(*),
    'conductores', count(distinct dni),
    'sentido_invertido', count(*) filter (where tipo = 'sentido_invertido'),
    'sin_cerrar', count(*) filter (where tipo = 'sin_cerrar'),
    'muy_corta', count(*) filter (where tipo = 'muy_corta'),
    'jornada_larga', count(*) filter (where tipo = 'jornada_larga'),
    'turno_cambiado', count(*) filter (where tipo = 'turno_cambiado'),
    'fuera_ventana', count(*) filter (where tipo = 'fuera_ventana')
  ) into v_totales from _anom;

  return jsonb_build_object(
    'ok', true, 'desde', p_desde, 'hasta', p_hasta,
    'totales', v_totales,
    'resumen', coalesce(v_resumen, '[]'::jsonb),
    'detalle', coalesce(v_detalle, '[]'::jsonb)
  );
end;
$function$;

grant execute on function public.reporte_jornadas_anomalas(date, date) to authenticated;
