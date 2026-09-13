-- Cierre automatico de un turno que quedo sin salida.
--
-- Problema que resuelve: si un conductor no marca la salida, al dia siguiente la app
-- veia "entrada abierta" y forzaba SALIDA en su llegada, invirtiendo el sentido y
-- arrastrando el error en cascada. Ahora, cuando la programacion dice que la persona
-- esta ENTRANDO, se cierra el turno viejo en su HORA PROGRAMADA de salida y se
-- registra la entrada real.
--
-- La marca creada NO es biometrica ni se envia a Buk: queda con origen
-- 'cierre_automatico' y enviado_buk=false para que administracion la revise y ajuste
-- la hora real si corresponde.

create or replace function public.cerrar_turno_automatico(
  p_entrada_id uuid,
  p_hora time default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_ent public.asistencias%rowtype;
  v_dni text;
  v_salida_ts timestamp;
  v_fecha date;
  v_hora time;
  v_row public.asistencias%rowtype;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  select * into v_ent from public.asistencias where id = p_entrada_id;
  if v_ent.id is null then
    return jsonb_build_object('ok', false, 'error', 'La marca de entrada no existe.');
  end if;
  if v_ent.sentido <> 'entrada' then
    return jsonb_build_object('ok', false, 'error', 'La marca indicada no es una entrada.');
  end if;

  -- Si ya existe una salida posterior, el turno no esta abierto: no se duplica.
  if exists (
    select 1 from public.asistencias s
     where s.colaborador_id = v_ent.colaborador_id
       and s.sentido = 'salida'
       and (s.fecha + s.hora)::timestamp > (v_ent.fecha + v_ent.hora)::timestamp
  ) then
    return jsonb_build_object('ok', false, 'error', 'Ese turno ya tiene una salida registrada.');
  end if;

  select c.dni into v_dni from public.colaboradores c where c.id = v_ent.colaborador_id;

  if p_hora is not null then
    -- Hora indicada a mano: se asume el mismo dia, o el siguiente si es anterior
    -- a la entrada (turno que cruza la medianoche).
    v_fecha := v_ent.fecha;
    v_hora := p_hora;
    if p_hora <= v_ent.hora then
      v_fecha := v_ent.fecha + 1;
    end if;
  else
    -- Hora PROGRAMADA de salida del turno al que pertenece esa entrada.
    select pt.salida_ts into v_salida_ts
      from public.programacion_turnos pt
     where pt.dni = v_dni
       and pt.fecha between v_ent.fecha - 1 and v_ent.fecha
       and pt.entrada_ts is not null and pt.salida_ts is not null
     order by abs(extract(epoch from ((v_ent.fecha + v_ent.hora)::timestamp - pt.entrada_ts)))
     limit 1;

    if v_salida_ts is null then
      return jsonb_build_object('ok', false, 'sin_programacion', true,
        'error', 'Ese turno no tiene hora de salida programada. Indica la hora a mano.');
    end if;
    v_fecha := v_salida_ts::date;
    v_hora := v_salida_ts::time;
  end if;

  insert into public.asistencias (
    colaborador_id, obra_id, fecha, hora, jornada, sentido,
    origen, registrado_por, observacion, enviado_buk,
    vehiculo_reporte, base_operativa, punto_operativo
  ) values (
    v_ent.colaborador_id, v_ent.obra_id, v_fecha, v_hora,
    coalesce(v_ent.jornada, v_ent.fecha), 'salida',
    'cierre_automatico', auth.uid(),
    'Cierre automatico: la entrada del ' || v_ent.fecha || ' ' || v_ent.hora
      || ' quedo sin salida. Se cierra en la hora programada. Revisar y ajustar la hora real si aplica.',
    false,
    v_ent.vehiculo_reporte, v_ent.base_operativa, v_ent.punto_operativo
  ) returning * into v_row;

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'fecha', v_row.fecha,
    'hora', to_char(v_row.hora, 'HH24:MI'),
    'entrada_fecha', v_ent.fecha,
    'entrada_hora', to_char(v_ent.hora, 'HH24:MI')
  );
end;
$function$;

grant execute on function public.cerrar_turno_automatico(uuid, time) to authenticated;
