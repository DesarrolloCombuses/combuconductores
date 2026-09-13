-- Criterio final de puntualidad, calibrado contra 12.786 marcas reales.
--
-- Dispersion (rango intercuartil) de cada campo de la programacion frente a la
-- marca biometrica real:
--
--   turno 1 ENTRADA vs INICIA      IQR   15 min  -> muy confiable
--   turno 2 ENTRADA vs INICIA 2    IQR   73 min  -> solo como hora limite
--   turno 2 SALIDA  vs HORA FIN    IQR  104 min  -> solo como hora limite
--   turno 1 SALIDA  vs INICIA 2    IQR  115 min  -> NO SIRVE
--
-- "INICIA 2" no es la hora de relevo entre conductores: en el vehiculo 729 del
-- 2026-07-21 decia 16:00 y el relevo real ocurrio 12:13-12:54. Por eso la salida
-- del conductor 1 queda marcada como 'no_evaluable' y nunca cuenta como falta:
-- es preferible no reportar a reportar una tardanza que no existe.
--
-- Faltas que SI se reportan:
--   * entrada despues de la hora programada (cualquier turno)
--   * salida del turno 2 antes de HORA FIN
-- Llegar antes o salir despues nunca es falta.

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

  new.puntualidad := case
    -- Salida del turno 1: la programacion no dice la hora de relevo. No se juzga.
    when new.sentido = 'salida' and v_prog.turno = 1 then 'no_evaluable'
    -- Salida del turno 2: la falta es irse antes de HORA FIN.
    when new.sentido = 'salida' then
      case when v_prog.minutos < -15 then 'temprano' else 'a_tiempo' end
    -- Entrada: la falta es llegar tarde. Llegar antes es normal.
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

-- Una sola definicion de "esto es una falta", usada por el reporte y por la app.
create or replace function public.es_falta_puntualidad(
  p_sentido text, p_turno smallint, p_minutos integer, p_tolerancia integer default 15
)
returns boolean
language sql
immutable
as $function$
  select case
    when p_minutos is null then false
    when p_sentido = 'salida' and coalesce(p_turno, 1) = 1 then false
    when p_sentido = 'salida' then p_minutos < -p_tolerancia
    else p_minutos > p_tolerancia
  end;
$function$;

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
  v_totales jsonb;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  -- Solo se verifica desde la fecha de corte; lo anterior no cuenta.
  p_desde := greatest(p_desde, public.fecha_corte_verificacion());
  if p_desde > p_hasta then
    return jsonb_build_object('ok', true, 'desde', p_desde, 'hasta', p_hasta,
      'tolerancia', p_tolerancia,
      'totales', jsonb_build_object('marcas', 0, 'evaluadas', 0, 'no_evaluables', 0,
                                    'faltas', 0, 'conductores', 0),
      'resumen', '[]'::jsonb, 'detalle', '[]'::jsonb);
  end if;

  create temp table _base on commit drop as
  select a.id, a.fecha, a.hora, a.sentido, a.hora_programada, a.minutos_diferencia,
         a.turno_programado, a.vehiculo_reporte, a.vehiculo_programado,
         c.dni, c.nombre,
         public.es_falta_puntualidad(a.sentido, a.turno_programado,
                                     a.minutos_diferencia, p_tolerancia) as es_falta,
         case when a.sentido = 'salida' then -a.minutos_diferencia
              else a.minutos_diferencia end as minutos_falta
    from public.asistencias a
    join public.colaboradores c on c.id = a.colaborador_id
   where a.fecha between p_desde and p_hasta
     and a.minutos_diferencia is not null;

  select jsonb_agg(jsonb_build_object(
           'id', id, 'fecha', fecha, 'hora', to_char(hora, 'HH24:MI'), 'sentido', sentido,
           'dni', dni, 'nombre', nombre,
           'tipo', case when sentido = 'salida' then 'salida_temprana' else 'entrada_tarde' end,
           'hora_programada', to_char(hora_programada, 'HH24:MI'),
           'minutos', minutos_falta, 'turno', turno_programado,
           'vehiculo', vehiculo_reporte, 'vehiculo_programado', vehiculo_programado
         ) order by fecha desc, hora desc)
    into v_detalle
    from _base where es_falta;

  select jsonb_agg(r order by (r->>'faltas')::int desc, (r->>'minutos_total')::int desc)
    into v_resumen
  from (
    select jsonb_build_object(
      'dni', dni, 'nombre', nombre,
      'marcas_evaluadas', count(*) filter (where not (sentido = 'salida' and coalesce(turno_programado,1) = 1)),
      'faltas', count(*) filter (where es_falta),
      'entrada_tarde', count(*) filter (where es_falta and sentido <> 'salida'),
      'salida_temprana', count(*) filter (where es_falta and sentido = 'salida'),
      'minutos_total', coalesce(sum(minutos_falta) filter (where es_falta), 0),
      'peor', coalesce(max(minutos_falta) filter (where es_falta), 0)
    ) as r
    from _base group by dni, nombre
    having count(*) filter (where es_falta) > 0
  ) y;

  select jsonb_build_object(
    'marcas', count(*),
    'evaluadas', count(*) filter (where not (sentido = 'salida' and coalesce(turno_programado,1) = 1)),
    'no_evaluables', count(*) filter (where sentido = 'salida' and coalesce(turno_programado,1) = 1),
    'faltas', count(*) filter (where es_falta),
    'conductores', count(distinct dni)
  ) into v_totales from _base;

  return jsonb_build_object(
    'ok', true, 'desde', p_desde, 'hasta', p_hasta, 'tolerancia', p_tolerancia,
    'totales', v_totales,
    'resumen', coalesce(v_resumen, '[]'::jsonb),
    'detalle', coalesce(v_detalle, '[]'::jsonb)
  );
end;
$function$;

grant execute on function public.es_falta_puntualidad(text, smallint, integer, integer) to authenticated;
grant execute on function public.reporte_puntualidad(date, date, integer) to authenticated;
