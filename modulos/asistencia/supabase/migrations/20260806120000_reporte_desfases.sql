-- Reporte de DESFASES de horario: cuanto se adelantan al entrar y cuanto se exceden
-- al salir, por conductor y por marca.
--
-- Se apoya en las columnas que el trigger de puntualidad ya calcula y guarda en cada
-- marca (turno_programado, hora_programada, minutos_diferencia, puntualidad), asi que
-- no recalcula nada: solo agrupa y ordena.
--
-- minutos_diferencia: negativo = ANTES de lo programado, positivo = DESPUES.
--   entrada negativa  -> se adelanto (llego antes del turno)
--   salida  positiva  -> se excedio (cerro despues de la hora fin)
--
-- Se excluye puntualidad='no_evaluable' (salida del turno 1): la programacion no
-- registra la hora de relevo, asi que ese desfase no significa nada.

create or replace function public.reporte_desfases(
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
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  p_desde := greatest(p_desde, public.fecha_corte_verificacion());
  if p_desde > p_hasta then
    return jsonb_build_object('ok', true, 'desde', p_desde, 'hasta', p_hasta,
      'totales', '{}'::jsonb, 'resumen', '[]'::jsonb, 'detalle', '[]'::jsonb);
  end if;

  create temp table _des on commit drop as
  select c.dni, c.nombre, a.fecha, a.sentido, a.hora,
         a.turno_programado as turno, a.hora_programada, a.minutos_diferencia as dif,
         a.vehiculo_reporte, a.base_operativa
    from public.asistencias a
    join public.colaboradores c on c.id = a.colaborador_id
   where a.fecha between p_desde and p_hasta
     and a.minutos_diferencia is not null
     and coalesce(a.puntualidad, '') <> 'no_evaluable';

  select jsonb_build_object(
    'marcas', count(*),
    'conductores', count(distinct dni),
    -- Entradas adelantadas (llegaron antes de su turno).
    'ent_antes_60',  count(*) filter (where sentido='entrada' and dif < -60),
    'ent_antes_120', count(*) filter (where sentido='entrada' and dif < -120),
    'ent_antes_180', count(*) filter (where sentido='entrada' and dif < -180),
    'ent_tarde_15',  count(*) filter (where sentido='entrada' and dif > 15),
    'ent_tarde_60',  count(*) filter (where sentido='entrada' and dif > 60),
    -- Salidas excedidas (cerraron despues de la hora fin) y anticipadas.
    'sal_despues_60',  count(*) filter (where sentido='salida' and dif > 60),
    'sal_despues_120', count(*) filter (where sentido='salida' and dif > 120),
    'sal_despues_240', count(*) filter (where sentido='salida' and dif > 240),
    'sal_antes_60',    count(*) filter (where sentido='salida' and dif < -60),
    'prom_entrada', round(avg(dif) filter (where sentido='entrada'))::int,
    'prom_salida',  round(avg(dif) filter (where sentido='salida'))::int
  ) into v_totales from _des;

  -- Un renglon por conductor, ordenado por quien mas tiempo de mas acumula.
  select jsonb_agg(r order by (r->>'exceso_total')::int desc)
    into v_resumen
  from (
    select jsonb_build_object(
      'dni', dni, 'nombre', nombre,
      'base', max(base_operativa),
      'n_entradas', count(*) filter (where sentido='entrada'),
      'prom_entrada', round(avg(dif) filter (where sentido='entrada'))::int,
      'max_antes_entrada', abs(least(min(dif) filter (where sentido='entrada'), 0))::int,
      'veces_ent_antes_60', count(*) filter (where sentido='entrada' and dif < -60),
      'n_salidas', count(*) filter (where sentido='salida'),
      'prom_salida', round(avg(dif) filter (where sentido='salida'))::int,
      'max_despues_salida', greatest(max(dif) filter (where sentido='salida'), 0)::int,
      'veces_sal_despues_60', count(*) filter (where sentido='salida' and dif > 60),
      -- Minutos "de mas" que suma en el rango: lo que se adelanta al entrar
      -- mas lo que se excede al salir. Sirve para ordenar quien mas destaca.
      'exceso_total', (
        coalesce(sum(-dif) filter (where sentido='entrada' and dif < 0), 0)
        + coalesce(sum(dif) filter (where sentido='salida' and dif > 0), 0)
      )::int
    ) as r
    from _des group by dni, nombre
  ) y;

  -- Detalle ordenado por el desfase mas llamativo primero.
  select jsonb_agg(d order by d_abs desc)
    into v_detalle
  from (
    select jsonb_build_object(
      'fecha', fecha, 'dni', dni, 'nombre', nombre,
      'base', base_operativa, 'turno', turno, 'sentido', sentido,
      'hora', to_char(hora, 'HH24:MI'),
      'hora_programada', to_char(hora_programada, 'HH24:MI'),
      'dif', dif, 'vehiculo', vehiculo_reporte
    ) as d,
    abs(dif) as d_abs
    from _des
    order by abs(dif) desc
    limit 500
  ) z;

  return jsonb_build_object(
    'ok', true, 'desde', p_desde, 'hasta', p_hasta,
    'totales', coalesce(v_totales, '{}'::jsonb),
    'resumen', coalesce(v_resumen, '[]'::jsonb),
    'detalle', coalesce(v_detalle, '[]'::jsonb)
  );
end;
$function$;

grant execute on function public.reporte_desfases(date, date) to authenticated;
