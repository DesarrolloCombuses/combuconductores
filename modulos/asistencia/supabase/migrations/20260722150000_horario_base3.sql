-- Tablero de fichos de BASE 3 (Terminal del Norte) por fecha.
-- El "ficho" es el numero '#' de la fila de programacion. Muestra ficho, vehiculo
-- y las tres horas (INICIA / INICIA 2 / HORA FIN). Solo lectura.
--
-- BASE 3 trae por vehiculo dos filas: la del horario real ('#' numerico, con horas)
-- y una fila "FICHO N" sin horas (reserva/standby, SIN CONDUCTOR). Aqui solo se
-- muestran las filas con horario (al menos una hora valida).

create or replace function public.horario_base3(p_fecha date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_filas jsonb;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  select jsonb_agg(x order by x_ficho_ord nulls last, x_inicia nulls last, x_veh)
    into v_filas
  from (
    select
      nullif(regexp_replace(coalesce(f.row_data->>'#', ''), '[^0-9]', '', 'g'), '')::int as x_ficho_ord,
      public.hora_programada_a_time(f.row_data->>'INICIA') as x_inicia,
      nullif(trim(coalesce(f.row_data->>'VEH', '')), '') as x_veh,
      jsonb_build_object(
        'ficho', nullif(trim(coalesce(f.row_data->>'#', '')), ''),
        'vehiculo', nullif(trim(coalesce(f.row_data->>'VEH', '')), ''),
        'inicia', to_char(public.hora_programada_a_time(f.row_data->>'INICIA'), 'HH24:MI'),
        'inicia2', to_char(public.hora_programada_a_time(f.row_data->>'INICIA 2'), 'HH24:MI'),
        'hora_fin', to_char(public.hora_programada_a_time(f.row_data->>'HORA FIN'), 'HH24:MI'),
        'puesto', nullif(trim(coalesce(f.row_data->>'PUESTO', '')), '')
      ) as x
    from public.programacion_filas f
    where f.fecha = p_fecha
      and (f.base = 'BASE 3' or f.row_data->>'BASE' = 'BASE 3')
      -- Solo filas con horario real (descarta las "FICHO N" de reserva sin horas).
      and (
        public.hora_programada_a_time(f.row_data->>'INICIA') is not null
        or public.hora_programada_a_time(f.row_data->>'INICIA 2') is not null
        or public.hora_programada_a_time(f.row_data->>'HORA FIN') is not null
      )
  ) t;

  return jsonb_build_object(
    'ok', true,
    'fecha', p_fecha,
    'total', coalesce(jsonb_array_length(v_filas), 0),
    'filas', coalesce(v_filas, '[]'::jsonb)
  );
end;
$function$;

grant execute on function public.horario_base3(date) to authenticated;
