-- Cierre de turno DECLARADO y con trazabilidad.
--
-- Antes: cuando alguien llegaba arrastrando un turno sin cerrar, la app cerraba el
-- turno viejo en su hora PROGRAMADA de salida, sin preguntar nada. Funcionaba para no
-- invertir el sentido, pero quedaba una salida inventada y sin explicacion: nadie sabia
-- si de verdad salio a esa hora ni por que no marco.
--
-- Ahora el operario declara DOS cosas, ambas obligatorias:
--   1. La hora real a la que termino ese turno (editable, se propone la programada).
--   2. El motivo por el que la salida no quedo registrada ese dia.
-- Todo queda en la tabla `cierres_turno`, que es la bitacora: quien lo declaro, cuando,
-- que hora dijo, cuanto se aparta de la programada y cuantas horas despues del hecho se
-- esta declarando. Asi se cierra la brecha de las marcas que no se cierran el dia que es.
--
-- La salida creada sigue sin ser biometrica y sin enviarse a Buk (origen
-- 'cierre_declarado', enviado_buk=false) para que administracion la revise.

create table if not exists public.cierres_turno (
  id                uuid primary key default gen_random_uuid(),
  entrada_id        uuid not null references public.asistencias(id) on delete cascade,
  salida_id         uuid references public.asistencias(id) on delete set null,
  colaborador_id    uuid not null references public.colaboradores(id) on delete cascade,
  dni               text,
  entrada_fecha     date not null,
  entrada_hora      time not null,
  salida_fecha      date not null,
  hora_declarada    time not null,   -- lo que dijo el operario
  hora_programada   time,            -- referencia de la programacion (puede no existir)
  minutos_ajuste    integer,         -- declarada - programada (negativo = salio antes)
  horas_jornada     numeric(5,2),    -- duracion resultante del turno
  horas_retraso     numeric(6,2),    -- cuanto despues del hecho se declara
  motivo            text not null,
  declarado_por     uuid default auth.uid(),
  declarado_nombre  text,
  created_at        timestamptz not null default now()
);

create index if not exists cierres_turno_entrada_idx  on public.cierres_turno (entrada_id);
create index if not exists cierres_turno_fecha_idx    on public.cierres_turno (entrada_fecha);
create index if not exists cierres_turno_colab_idx    on public.cierres_turno (colaborador_id);

alter table public.cierres_turno enable row level security;

drop policy if exists cierres_turno_lectura on public.cierres_turno;
create policy cierres_turno_lectura on public.cierres_turno
  for select to authenticated using (true);

-- Solo se escribe por la funcion (security definer); nadie inserta a mano.
drop policy if exists cierres_turno_sin_escritura on public.cierres_turno;

comment on table public.cierres_turno is
  'Bitacora de turnos cerrados a mano por un operario: hora declarada, motivo y quien lo declaro.';

-- La firma cambia (se agrega el motivo obligatorio): se elimina la anterior para que no
-- queden dos sobrecargas y la llamada de 2 argumentos quede ambigua.
drop function if exists public.cerrar_turno_automatico(uuid, time);

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

  -- Si ya existe una salida posterior, el turno no esta abierto: no se duplica.
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

  -- Hora PROGRAMADA de salida del turno al que pertenece esa entrada: sirve de
  -- propuesta y, sobre todo, de referencia para medir cuanto se aparto lo declarado.
  select pt.salida_ts into v_salida_ts
    from public.programacion_turnos pt
   where pt.dni = v_dni
     and pt.fecha between v_ent.fecha - 1 and v_ent.fecha
     and pt.entrada_ts is not null and pt.salida_ts is not null
   order by abs(extract(epoch from ((v_ent.fecha + v_ent.hora)::timestamp - pt.entrada_ts)))
   limit 1;
  v_prog := v_salida_ts::time;

  if p_hora is not null then
    -- Hora declarada por el operario. Se asume el mismo dia, o el siguiente si es
    -- anterior o igual a la entrada (turno que cruza la medianoche).
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
  -- No se puede declarar una salida que todavia no ha ocurrido (margen de 15 min por
  -- si el reloj del equipo va un poco atrasado).
  if v_retraso < -0.25 then
    return jsonb_build_object('ok', false,
      'error', 'Esa hora todavia no ha llegado. Solo se declara una salida ya ocurrida.');
  end if;

  -- Quien declara: se busca su nombre en los perfiles y, si no esta, se deja el usuario
  -- del correo. Nunca queda anonimo: la bitacora tiene que decir quien fue.
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


-- Bitacora para Administracion: que turnos se cerraron a mano, con que hora y por que.
create or replace function public.reporte_cierres_turno(
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
  v_motivos jsonb;
  v_tot jsonb;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;
  if p_desde is null or p_hasta is null or p_desde > p_hasta then
    return jsonb_build_object('ok', false, 'error', 'Rango de fechas invalido.');
  end if;

  create temp table _ct on commit drop as
  select ct.*,
         c.nombre,
         coalesce(c.especialidad, '') as cargo,
         a.hora as salida_hora_actual,
         a.fecha as salida_fecha_actual
    from public.cierres_turno ct
    join public.colaboradores c on c.id = ct.colaborador_id
    left join public.asistencias a on a.id = ct.salida_id
   where ct.entrada_fecha between p_desde and p_hasta;

  select coalesce(jsonb_agg(x order by x.entrada_fecha desc, x.entrada_hora desc), '[]'::jsonb)
    into v_detalle
    from (
      select entrada_fecha, to_char(entrada_hora, 'HH24:MI') as entrada_hora,
             salida_fecha,
             to_char(hora_declarada, 'HH24:MI') as hora_declarada,
             to_char(hora_programada, 'HH24:MI') as hora_programada,
             -- Si administracion ya corrigio la hora en el verificador, se ve aqui.
             to_char(salida_hora_actual, 'HH24:MI') as hora_actual,
             (salida_hora_actual is distinct from hora_declarada) as corregida,
             minutos_ajuste, horas_jornada, horas_retraso,
             motivo, declarado_nombre, dni, nombre, cargo,
             salida_id, entrada_id,
             to_char(created_at at time zone 'America/Bogota', 'YYYY-MM-DD HH24:MI') as declarado_at
        from _ct
    ) x;

  select coalesce(jsonb_agg(m order by m.veces desc), '[]'::jsonb)
    into v_motivos
    from (select motivo, count(*)::int as veces from _ct group by motivo) m;

  select jsonb_build_object(
           'cierres', count(*)::int,
           'personas', count(distinct colaborador_id)::int,
           'corregidos', count(*) filter (where salida_hora_actual is distinct from hora_declarada)::int,
           'retraso_mediano', round(percentile_disc(0.5) within group (order by horas_retraso)::numeric, 1),
           'ajuste_mediano', percentile_disc(0.5) within group (order by minutos_ajuste)
         )
    into v_tot
    from _ct;

  return jsonb_build_object('ok', true, 'desde', p_desde, 'hasta', p_hasta,
                            'totales', v_tot, 'motivos', v_motivos, 'detalle', v_detalle);
end;
$function$;

grant execute on function public.reporte_cierres_turno(date, date) to authenticated;
