-- La hora que se propone al cerrar un turno tiene que ser creible.
--
-- Caso que lo destapo (AGUAS ALVAREZ KEVIN, 1001546041):
--   entrada abierta   09-ago 15:38
--   programacion 09-ago: turno 1, 05:00 a 13:00
--   la app proponia    13:00  ->  jornada de 22,4 h
--
-- El turno programado de ese dia empieza a las 05:00, o sea a 638 MINUTOS de la marca
-- real de las 15:38. No es el turno de esa entrada, pero se tomaba igual porque el
-- emparejamiento cogia "el turno mas cercano" sin ningun limite de distancia.
--
-- Sus jornadas reales dicen otra cosa. Este conductor pasa a turno nocturno:
--   07-ago 14:03 -> 08-ago 05:36   15,6 h
--   08-ago 14:09 -> 09-ago 05:01   14,9 h
-- La entrada de las 15:38 debia cerrar hacia las 05:00, unas 13,4 h. La programacion
-- de ese dia estaba desactualizada frente a lo que la persona realmente hace.
--
-- Esta funcion devuelve DOS sugerencias, cada una con su procedencia, para que la app
-- diga de donde sale la hora en vez de presentarla como un hecho:
--
--   programada -> hora de salida del turno del dia, SOLO si su hora de entrada esta
--                 a menos de 3 h de la marca real. Si no, no se propone nada.
--   habitual   -> la salida de la ultima jornada cerrada cuya ENTRADA fue a una hora
--                 parecida (± 3 h). Es lo que de verdad hace esa persona a esa hora.
--
-- 3 h es el mismo margen que ya usa la app para decidir el sentido por programacion
-- (SENTIDO_PROG_MAX_MIN), asi que el criterio es uno solo en todo el flujo.

create or replace function public.sugerencia_cierre_turno(p_entrada_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_ent public.asistencias%rowtype;
  v_dni text;
  v_lim numeric := public.limite_horas_jornada();
  v_margen constant interval := interval '3 hours';
  v_prog record;
  v_hab record;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  select * into v_ent from public.asistencias where id = p_entrada_id;
  if v_ent.id is null or v_ent.sentido <> 'entrada' then
    return jsonb_build_object('ok', false, 'error', 'Marca de entrada no encontrada.');
  end if;

  select c.dni into v_dni from public.colaboradores c where c.id = v_ent.colaborador_id;

  -- 1. Turno programado, pero solo si de verdad corresponde a esta entrada.
  select pt.turno, pt.hora_entrada, pt.hora_salida, pt.salida_ts, pt.entrada_ts,
         abs(extract(epoch from ((v_ent.fecha + v_ent.hora)::timestamp - pt.entrada_ts)))/60 as dist_min
    into v_prog
    from public.programacion_turnos pt
   where pt.dni = v_dni
     and pt.fecha between v_ent.fecha - 1 and v_ent.fecha
     and pt.entrada_ts is not null and pt.salida_ts is not null
     and abs(extract(epoch from ((v_ent.fecha + v_ent.hora)::timestamp - pt.entrada_ts)))
         <= extract(epoch from v_margen)
   order by abs(extract(epoch from ((v_ent.fecha + v_ent.hora)::timestamp - pt.entrada_ts)))
   limit 1;

  -- 2. Lo que esa persona hace de verdad cuando entra a esta hora: la ultima jornada
  --    cerrada con entrada parecida y duracion razonable.
  with pares as (
    select e.fecha as ent_fecha, e.hora as ent_hora,
           (e.fecha + e.hora)::timestamp as ent_ts,
           (select min((s.fecha + s.hora)::timestamp)
              from public.asistencias s
             where s.colaborador_id = v_ent.colaborador_id
               and s.sentido = 'salida'
               and (s.fecha + s.hora)::timestamp > (e.fecha + e.hora)::timestamp) as sal_ts
      from public.asistencias e
     where e.colaborador_id = v_ent.colaborador_id
       and e.sentido = 'entrada'
       and e.id <> v_ent.id
       and e.fecha between v_ent.fecha - 30 and v_ent.fecha
  )
  select ent_fecha, sal_ts,
         round(extract(epoch from (sal_ts - ent_ts))::numeric / 3600, 1) as horas,
         -- Distancia entre horas del dia, contando la vuelta por medianoche.
         least(abs(extract(epoch from (ent_hora - v_ent.hora))),
               86400 - abs(extract(epoch from (ent_hora - v_ent.hora)))) / 60 as dist_min
    into v_hab
    from pares
   where sal_ts is not null
     and extract(epoch from (sal_ts - ent_ts)) / 3600 between 4 and v_lim
     and least(abs(extract(epoch from (ent_hora - v_ent.hora))),
               86400 - abs(extract(epoch from (ent_hora - v_ent.hora))))
         <= extract(epoch from v_margen)
   order by ent_ts desc
   limit 1;

  return jsonb_build_object(
    'ok', true,
    'entrada_fecha', v_ent.fecha,
    'entrada_hora', to_char(v_ent.hora, 'HH24:MI'),
    'limite_horas', v_lim,
    'programada', case when v_prog.hora_salida is null then null else jsonb_build_object(
        'hora', to_char(v_prog.hora_salida, 'HH24:MI'),
        'turno', v_prog.turno,
        'hora_entrada', to_char(v_prog.hora_entrada, 'HH24:MI'),
        'dist_min', round(v_prog.dist_min)
      ) end,
    'habitual', case when v_hab.sal_ts is null then null else jsonb_build_object(
        'hora', to_char(v_hab.sal_ts, 'HH24:MI'),
        'fecha_ref', v_hab.ent_fecha,
        'horas', v_hab.horas,
        'dist_min', round(v_hab.dist_min)
      ) end
  );
end;
$function$;

grant execute on function public.sugerencia_cierre_turno(uuid) to authenticated;


-- cerrar_turno_automatico usaba el mismo emparejamiento sin limite para calcular
-- `hora_programada` y `minutos_ajuste`. Con eso, el "60 min despues de la programada"
-- del caso de arriba se medía contra un turno ajeno. Se le pone el mismo margen de 3 h:
-- si no hay turno creible, la referencia queda en NULL y no se inventa un ajuste.
create or replace function public.cerrar_turno_automatico(
  p_entrada_id uuid,
  p_hora time default null,
  p_motivo text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_ent public.asistencias%rowtype;
  v_dni text;
  v_nombre text;
  v_quien text;
  v_salida_ts timestamp;
  v_prog time;
  v_fecha date;
  v_hora time;
  v_motivo text;
  v_ahora timestamp;
  v_row public.asistencias%rowtype;
  v_jornada numeric(5,2);
  v_retraso numeric(6,2);
  v_ajuste integer;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  v_motivo := nullif(btrim(coalesce(p_motivo, '')), '');
  if v_motivo is null or length(v_motivo) < 4 then
    return jsonb_build_object('ok', false,
      'error', 'Falta el motivo por el que no quedo registrada la salida.');
  end if;

  select * into v_ent from public.asistencias where id = p_entrada_id;
  if v_ent.id is null then
    return jsonb_build_object('ok', false, 'error', 'La marca de entrada no existe.');
  end if;
  if v_ent.sentido <> 'entrada' then
    return jsonb_build_object('ok', false, 'error', 'La marca indicada no es una entrada.');
  end if;

  if exists (
    select 1 from public.asistencias s
     where s.colaborador_id = v_ent.colaborador_id
       and s.sentido = 'salida'
       and (s.fecha + s.hora)::timestamp > (v_ent.fecha + v_ent.hora)::timestamp
  ) then
    return jsonb_build_object('ok', false, 'error', 'Ese turno ya tiene una salida registrada.');
  end if;

  select c.dni, c.nombre into v_dni, v_nombre
    from public.colaboradores c where c.id = v_ent.colaborador_id;

  -- Turno de ESTA entrada: su hora programada de entrada tiene que estar a menos de
  -- 3 h de la marca real. Si no, no es su turno y no sirve como referencia.
  select pt.salida_ts into v_salida_ts
    from public.programacion_turnos pt
   where pt.dni = v_dni
     and pt.fecha between v_ent.fecha - 1 and v_ent.fecha
     and pt.entrada_ts is not null and pt.salida_ts is not null
     and abs(extract(epoch from ((v_ent.fecha + v_ent.hora)::timestamp - pt.entrada_ts))) <= 3 * 3600
   order by abs(extract(epoch from ((v_ent.fecha + v_ent.hora)::timestamp - pt.entrada_ts)))
   limit 1;
  v_prog := v_salida_ts::time;

  if p_hora is not null then
    v_fecha := v_ent.fecha;
    v_hora := p_hora;
    if p_hora <= v_ent.hora then
      v_fecha := v_ent.fecha + 1;
    end if;
  elsif v_salida_ts is not null then
    v_fecha := v_salida_ts::date;
    v_hora := v_salida_ts::time;
  else
    return jsonb_build_object('ok', false, 'sin_programacion', true,
      'error', 'Ese turno no tiene hora de salida programada. Indica la hora a mano.');
  end if;

  v_ahora   := (now() at time zone 'America/Bogota');
  v_jornada := round(extract(epoch from
                 ((v_fecha + v_hora)::timestamp - (v_ent.fecha + v_ent.hora)::timestamp)
               )::numeric / 3600, 2);
  v_retraso := round(extract(epoch from (v_ahora - (v_fecha + v_hora)::timestamp))::numeric / 3600, 2);
  v_ajuste  := case when v_prog is null then null
                    else round(extract(epoch from (v_hora - v_prog)) / 60)::integer end;

  if v_jornada <= 0 then
    return jsonb_build_object('ok', false,
      'error', 'La hora indicada queda antes de la entrada. Revisala.');
  end if;
  if v_jornada > 24 then
    return jsonb_build_object('ok', false,
      'error', 'Esa hora daria una jornada de mas de 24 h. Revisala.');
  end if;
  if v_retraso < -0.25 then
    return jsonb_build_object('ok', false,
      'error', 'Esa hora todavia no ha llegado. Solo se declara una salida ya ocurrida.');
  end if;

  select coalesce(pf.nombre, pr.full_name, split_part(u.email, '@', 1)) into v_quien
    from auth.users u
    left join public.perfiles pf on pf.user_id = u.id
    left join public.profiles pr on pr.id      = u.id
   where u.id = auth.uid();

  insert into public.asistencias (
    colaborador_id, obra_id, fecha, hora, jornada, sentido,
    origen, registrado_por, observacion, enviado_buk,
    vehiculo_reporte, base_operativa, punto_operativo, hora_programada
  ) values (
    v_ent.colaborador_id, v_ent.obra_id, v_fecha, v_hora,
    coalesce(v_ent.jornada, v_ent.fecha), 'salida',
    'cierre_declarado', auth.uid(),
    'Cierre declarado: la entrada del ' || v_ent.fecha || ' ' || to_char(v_ent.hora, 'HH24:MI')
      || ' quedo sin salida. Hora declarada por quien registra: ' || to_char(v_hora, 'HH24:MI')
      || coalesce(' (programada ' || to_char(v_prog, 'HH24:MI') || ')', ' (sin hora programada)')
      || ' | Jornada ' || v_jornada || ' h'
      || ' | Declarado ' || v_retraso || ' h despues por '
      || coalesce(v_quien, 'usuario ' || left(auth.uid()::text, 8))
      || ' | Motivo: ' || v_motivo,
    false,
    v_ent.vehiculo_reporte, v_ent.base_operativa, v_ent.punto_operativo, v_prog
  ) returning * into v_row;

  insert into public.cierres_turno (
    entrada_id, salida_id, colaborador_id, dni,
    entrada_fecha, entrada_hora, salida_fecha,
    hora_declarada, hora_programada, minutos_ajuste,
    horas_jornada, horas_retraso, motivo, declarado_nombre
  ) values (
    v_ent.id, v_row.id, v_ent.colaborador_id, v_dni,
    v_ent.fecha, v_ent.hora, v_fecha,
    v_hora, v_prog, v_ajuste,
    v_jornada, v_retraso, v_motivo, v_quien
  );

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'fecha', v_row.fecha,
    'hora', to_char(v_row.hora, 'HH24:MI'),
    'hora_programada', to_char(v_prog, 'HH24:MI'),
    'minutos_ajuste', v_ajuste,
    'horas_jornada', v_jornada,
    'horas_retraso', v_retraso,
    'declarado_por', v_quien,
    'entrada_fecha', v_ent.fecha,
    'entrada_hora', to_char(v_ent.hora, 'HH24:MI'),
    'nombre', v_nombre,
    'motivo', v_motivo
  );
end;
$function$;

grant execute on function public.cerrar_turno_automatico(uuid, time, text) to authenticated;
