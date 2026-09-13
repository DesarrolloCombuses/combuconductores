-- Corrección de horas de ingreso/salida por el administrador (pestaña "Corregir
-- horas"). Actualiza SOLO la hora en la base local; deja traza en la observación.
-- No toca Buk (Buk no permite editar una marca ya enviada; se maneja aparte).
-- Solo usuarios autenticados.

create or replace function public.actualizar_hora_asistencia(p_id uuid, p_hora time)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_old time;
  v_row public.asistencias%rowtype;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  select hora into v_old from public.asistencias where id = p_id;
  if v_old is null then
    return jsonb_build_object('ok', false, 'error', 'La marca no existe.');
  end if;

  update public.asistencias
     set hora = p_hora,
         observacion = left(
           coalesce(observacion, '') ||
           ' | hora corregida de ' || v_old::text || ' a ' || p_hora::text || ' (admin)', 800)
   where id = p_id
   returning * into v_row;

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'fecha', v_row.fecha,
    'hora', v_row.hora::text,
    'sentido', v_row.sentido
  );
end;
$function$;

grant execute on function public.actualizar_hora_asistencia(uuid, time) to authenticated;
