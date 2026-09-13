-- Marcas con ubicacion para el mapa de verificacion de posiciones.
-- Devuelve lat/lon, conductor, sentido, hora y precision de cada registro biometrico
-- en un rango de fechas. Solo lectura, para administracion.

create or replace function public.marcas_con_ubicacion(
  p_desde date,
  p_hasta date,
  p_buscar text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_filas jsonb;
  v_total int;
  v_buscar text;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  if p_desde > p_hasta then
    return jsonb_build_object('ok', false, 'error', 'La fecha inicial no puede ser mayor que la final.');
  end if;
  if p_hasta - p_desde > 60 then
    return jsonb_build_object('ok', false, 'error', 'El rango no puede superar 60 dias.');
  end if;

  v_buscar := nullif(trim(coalesce(p_buscar, '')), '');

  with base as (
    select a.id, a.fecha, a.hora, a.sentido, a.latitud, a.longitud,
           a.ubicacion_precision_m, a.vehiculo_reporte, a.origen, c.dni, c.nombre
      from public.asistencias a
      join public.colaboradores c on c.id = a.colaborador_id
     where a.fecha between p_desde and p_hasta
       and a.latitud is not null and a.longitud is not null
       and (
         v_buscar is null
         or c.nombre ilike '%' || v_buscar || '%'
         or coalesce(c.dni, '') ilike '%' || v_buscar || '%'
         or coalesce(a.vehiculo_reporte, '') ilike '%' || v_buscar || '%'
       )
  ),
  limitado as (
    select * from base order by fecha desc, hora desc limit 3000
  )
  select jsonb_agg(jsonb_build_object(
           'id', id, 'dni', dni, 'nombre', nombre,
           'fecha', fecha, 'hora', to_char(hora, 'HH24:MI'),
           'sentido', sentido,
           'lat', round(latitud::numeric, 6), 'lon', round(longitud::numeric, 6),
           'precision', round(coalesce(ubicacion_precision_m, 0)::numeric, 0),
           'vehiculo', vehiculo_reporte, 'origen', origen
         )),
         (select count(*) from base)
    into v_filas, v_total
    from limitado;

  return jsonb_build_object(
    'ok', true, 'desde', p_desde, 'hasta', p_hasta,
    'total', coalesce(v_total, 0),
    'mostrados', coalesce(jsonb_array_length(v_filas), 0),
    'marcas', coalesce(v_filas, '[]'::jsonb)
  );
end;
$function$;

grant execute on function public.marcas_con_ubicacion(date, date, text) to authenticated;
