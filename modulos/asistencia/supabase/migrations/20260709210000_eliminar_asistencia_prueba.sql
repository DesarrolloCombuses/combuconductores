-- Funcion TEMPORAL para borrar marcas durante las pruebas locales.
-- Se usa desde el panel de Administracion (boton "Eliminar" en cada marca), que
-- esta gateado en el cliente por un interruptor (HABILITAR_ELIMINAR_MARCAS).
-- Cuando terminen las pruebas: poner ese flag en false en el cliente. Si ademas
-- quieres bloquearlo del todo en la base, ejecuta:
--   revoke execute on function public.eliminar_asistencia(uuid) from authenticated;
--
-- Nota: solo permite borrar a un usuario autenticado (auth.uid() no nulo).

create or replace function public.eliminar_asistencia(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_row public.asistencias%rowtype;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  delete from public.asistencias
  where id = p_id
  returning * into v_row;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'La marca no existe (ya fue borrada).');
  end if;

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'fecha', v_row.fecha,
    'hora', v_row.hora::text,
    'sentido', v_row.sentido
  );
end;
$function$;

grant execute on function public.eliminar_asistencia(uuid) to authenticated;
