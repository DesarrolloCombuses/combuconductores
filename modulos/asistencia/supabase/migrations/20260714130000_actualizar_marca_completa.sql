-- Edición COMPLETA de una marca por el administrador (pestaña "Corregir horas"):
-- fecha, hora, sentido (entrada/salida) y vehículo. Solo base local; deja traza en
-- la observación. Solo usuarios autenticados. (El borrado usa eliminar_asistencia.)

create or replace function public.actualizar_marca_asistencia(
  p_id uuid,
  p_fecha date,
  p_hora time,
  p_sentido text,
  p_vehiculo text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_old public.asistencias%rowtype;
  v_row public.asistencias%rowtype;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;
  if p_sentido not in ('entrada', 'salida') then
    return jsonb_build_object('ok', false, 'error', 'El sentido debe ser entrada o salida.');
  end if;

  select * into v_old from public.asistencias where id = p_id;
  if v_old.id is null then
    return jsonb_build_object('ok', false, 'error', 'La marca no existe.');
  end if;

  update public.asistencias
     set fecha = p_fecha,
         hora = p_hora,
         sentido = p_sentido,
         vehiculo_reporte = nullif(trim(coalesce(p_vehiculo, '')), ''),
         observacion = left(
           coalesce(observacion, '') ||
           ' | editada por admin (' || v_old.fecha || ' ' || v_old.hora || ' ' || v_old.sentido ||
           ' -> ' || p_fecha || ' ' || p_hora || ' ' || p_sentido || ')', 900)
   where id = p_id
   returning * into v_row;

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'fecha', v_row.fecha,
    'hora', v_row.hora::text,
    'sentido', v_row.sentido,
    'vehiculo', v_row.vehiculo_reporte
  );
end;
$function$;

grant execute on function public.actualizar_marca_asistencia(uuid, date, time, text, text) to authenticated;
