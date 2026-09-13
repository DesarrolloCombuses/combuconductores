-- Segunda parte del cruce programacion <-> biometrico:
--   1. Resolucion de nombres usando el CSV de colaboradores (fuente real, 918 filas),
--      porque public.colaboradores es solo un cache parcial de quienes ya marcaron.
--   2. Columnas de puntualidad en asistencias, llenadas por trigger (no por la app,
--      para que no se puedan falsear desde el cliente).
--   3. Reporte de tardanzas para el panel de administracion.

-- ---------------------------------------------------------------------------
-- 1. Resolucion de nombres contra la lista que envia la app (CSV)
-- ---------------------------------------------------------------------------

create or replace function public.sincronizar_nombres_programacion(p_personas jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_nuevos int := 0;
  v_exacto int := 0;
  v_orden int := 0;
  v_parecido int := 0;
  v_pendientes int := 0;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  -- Nombres que aparecen en la programacion y aun no estan en el puente.
  with nombres as (
    select distinct trim(x) as nombre
    from (
      select row_data->>'CONDUCTOR 1' as x from public.programacion_filas
      union all
      select row_data->>'CONDUCTOR 2' from public.programacion_filas
    ) t
    where public.normalizar_nombre(x) is not null
  )
  insert into public.programacion_conductor_dni (nombre_norm, nombre_programacion)
  select public.normalizar_nombre(nombre), nombre from nombres
  on conflict (nombre_norm) do nothing;
  get diagnostics v_nuevos = row_count;

  update public.programacion_conductor_dni
     set metodo = 'ignorado', revisado = true, actualizado_en = now()
   where dni is null and not revisado
     and (nombre_norm like '%SIN CONDUCTOR%'
          or nombre_norm like '%SIN PROGRAMAR%'
          or array_length(string_to_array(nombre_norm, ' '), 1) < 2);

  create temp table _personas on commit drop as
  select distinct
         regexp_replace(coalesce(e->>'dni', ''), '[^0-9]', '', 'g') as dni,
         trim(coalesce(e->>'nombre', '')) as nombre
    from jsonb_array_elements(coalesce(p_personas, '[]'::jsonb)) e;
  delete from _personas where dni = '' or nombre = '';

  -- Cruce exacto.
  update public.programacion_conductor_dni p
     set dni = s.dni, nombre_colaborador = s.nombre, metodo = 'exacto',
         similitud = 1, actualizado_en = now()
    from _personas s
   where p.dni is null and not p.revisado
     and public.normalizar_nombre(s.nombre) = p.nombre_norm
     and (select count(*) from _personas s2
           where public.normalizar_nombre(s2.nombre) = p.nombre_norm) = 1;
  get diagnostics v_exacto = row_count;

  -- Mismo nombre, otro orden de palabras.
  update public.programacion_conductor_dni p
     set dni = s.dni, nombre_colaborador = s.nombre, metodo = 'orden',
         similitud = 1, actualizado_en = now()
    from _personas s
   where p.dni is null and not p.revisado
     and public.normalizar_nombre_tokens(s.nombre) = public.normalizar_nombre_tokens(p.nombre_norm)
     and (select count(*) from _personas s2
           where public.normalizar_nombre_tokens(s2.nombre)
               = public.normalizar_nombre_tokens(p.nombre_norm)) = 1;
  get diagnostics v_orden = row_count;

  -- Parecido, solo si le saca ventaja clara al segundo candidato.
  update public.programacion_conductor_dni p
     set dni = m.dni, nombre_colaborador = m.nombre, metodo = 'parecido',
         similitud = round(m.sim::numeric, 3), actualizado_en = now()
    from (
      select x.nombre_norm, x.dni, x.nombre, x.sim
      from (
        select p2.nombre_norm, s.dni, s.nombre,
               similarity(public.normalizar_nombre_tokens(p2.nombre_norm),
                          public.normalizar_nombre_tokens(s.nombre)) as sim,
               row_number() over (partition by p2.nombre_norm order by
                 similarity(public.normalizar_nombre_tokens(p2.nombre_norm),
                            public.normalizar_nombre_tokens(s.nombre)) desc) as rn,
               lead(similarity(public.normalizar_nombre_tokens(p2.nombre_norm),
                               public.normalizar_nombre_tokens(s.nombre))) over (
                 partition by p2.nombre_norm order by
                 similarity(public.normalizar_nombre_tokens(p2.nombre_norm),
                            public.normalizar_nombre_tokens(s.nombre)) desc) as sim2
        from public.programacion_conductor_dni p2
        cross join _personas s
        where p2.dni is null and not p2.revisado
      ) x
      where x.rn = 1 and x.sim >= 0.80 and (x.sim2 is null or x.sim - x.sim2 >= 0.08)
    ) m
   where p.nombre_norm = m.nombre_norm and p.dni is null and not p.revisado;
  get diagnostics v_parecido = row_count;

  update public.programacion_conductor_dni
     set metodo = 'sin_cruce', actualizado_en = now()
   where dni is null and not revisado and coalesce(metodo, '') <> 'sin_cruce';

  select count(*) into v_pendientes
    from public.programacion_conductor_dni where dni is null and not revisado;

  return jsonb_build_object('ok', true, 'nombres_nuevos', v_nuevos, 'exacto', v_exacto,
    'orden', v_orden, 'parecido', v_parecido, 'sin_resolver', v_pendientes);
end;
$function$;

-- La asignacion manual ya no exige que la cedula este en public.colaboradores
-- (puede ser alguien del CSV que todavia no ha marcado nunca).
create or replace function public.asignar_dni_programacion(
  p_nombre_norm text,
  p_dni text,
  p_nombre text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_dni text;
  v_nombre text;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  v_dni := regexp_replace(coalesce(p_dni, ''), '[^0-9]', '', 'g');

  if v_dni = '' then
    update public.programacion_conductor_dni
       set dni = null, nombre_colaborador = null, metodo = 'ignorado',
           revisado = true, actualizado_en = now()
     where nombre_norm = p_nombre_norm;
    return jsonb_build_object('ok', true, 'dni', null);
  end if;

  select nombre into v_nombre from public.colaboradores where dni = v_dni;
  v_nombre := coalesce(nullif(trim(coalesce(p_nombre, '')), ''), v_nombre);

  update public.programacion_conductor_dni
     set dni = v_dni, nombre_colaborador = v_nombre, metodo = 'manual',
         similitud = null, revisado = true, actualizado_en = now()
   where nombre_norm = p_nombre_norm;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Ese nombre no esta en la programacion.');
  end if;

  return jsonb_build_object('ok', true, 'dni', v_dni, 'nombre', v_nombre);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Puntualidad en cada marca (la calcula el servidor, no la app)
-- ---------------------------------------------------------------------------

alter table public.asistencias
  add column if not exists hora_programada time,
  add column if not exists vehiculo_programado text,
  add column if not exists turno_programado smallint,
  add column if not exists minutos_diferencia integer,
  add column if not exists puntualidad text;

comment on column public.asistencias.minutos_diferencia is
  'hora marcada - hora programada, en minutos. Positivo = despues de lo programado.';
comment on column public.asistencias.puntualidad is
  'a_tiempo (|dif| <= 15 min) | tarde | temprano | sin_programacion';

-- Devuelve el turno programado que mejor corresponde a una marca.
create or replace function public.programacion_de_marca(
  p_dni text, p_fecha date, p_hora time, p_sentido text
)
returns table (
  turno smallint, hora_programada time, vehiculo text, base text, puesto text
)
language sql
stable
security definer
set search_path = public
as $function$
  select v.turno,
         case when p_sentido = 'salida' then v.hora_salida else v.hora_entrada end,
         v.vehiculo, v.base, v.puesto
    from public.v_programacion_conductor v
   where v.dni = regexp_replace(coalesce(p_dni, ''), '[^0-9]', '', 'g')
     and v.fecha = p_fecha
     and (case when p_sentido = 'salida' then v.hora_salida else v.hora_entrada end) is not null
   -- Si el conductor tiene dos turnos ese dia, gana el mas cercano a la hora marcada.
   order by abs(extract(epoch from (
              p_hora - (case when p_sentido = 'salida' then v.hora_salida else v.hora_entrada end))))
   limit 1;
$function$;

create or replace function public.calcular_puntualidad_asistencia()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_dni text;
  v_prog record;
  v_dif integer;
begin
  new.hora_programada := null;
  new.vehiculo_programado := null;
  new.turno_programado := null;
  new.minutos_diferencia := null;
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

  v_dif := round(extract(epoch from (new.hora - v_prog.hora_programada)) / 60.0);

  new.hora_programada := v_prog.hora_programada;
  new.vehiculo_programado := v_prog.vehiculo;
  new.turno_programado := v_prog.turno;
  new.minutos_diferencia := v_dif;
  new.puntualidad := case
    when v_dif > 15 then 'tarde'
    when v_dif < -15 then 'temprano'
    else 'a_tiempo'
  end;

  return new;
exception when others then
  -- Nunca bloquear el registro de una marca por un problema de programacion.
  return new;
end;
$function$;

drop trigger if exists trg_puntualidad_asistencia on public.asistencias;
create trigger trg_puntualidad_asistencia
  before insert or update of fecha, hora, sentido, colaborador_id
  on public.asistencias
  for each row execute function public.calcular_puntualidad_asistencia();

-- ---------------------------------------------------------------------------
-- 3. Reporte de tardanzas
-- ---------------------------------------------------------------------------

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
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  select jsonb_agg(t order by t->>'fecha' desc, t->>'hora' desc) into v_detalle
  from (
    select jsonb_build_object(
      'id', a.id, 'fecha', a.fecha, 'hora', to_char(a.hora, 'HH24:MI'),
      'sentido', a.sentido, 'dni', c.dni, 'nombre', c.nombre,
      'hora_programada', to_char(a.hora_programada, 'HH24:MI'),
      'minutos', a.minutos_diferencia, 'turno', a.turno_programado,
      'vehiculo', a.vehiculo_reporte, 'vehiculo_programado', a.vehiculo_programado,
      'estado', case
        when a.minutos_diferencia is null then 'sin_programacion'
        when a.minutos_diferencia > p_tolerancia then 'tarde'
        when a.minutos_diferencia < -p_tolerancia then 'temprano'
        else 'a_tiempo' end
    ) as t
    from public.asistencias a
    join public.colaboradores c on c.id = a.colaborador_id
    where a.fecha between p_desde and p_hasta
      and a.hora_programada is not null
      and a.minutos_diferencia > p_tolerancia
  ) x;

  select jsonb_agg(r order by (r->>'tarde')::int desc) into v_resumen
  from (
    select jsonb_build_object(
      'dni', c.dni, 'nombre', c.nombre,
      'marcas', count(*),
      'tarde', count(*) filter (where a.minutos_diferencia > p_tolerancia),
      'temprano', count(*) filter (where a.minutos_diferencia < -p_tolerancia),
      'a_tiempo', count(*) filter (where abs(a.minutos_diferencia) <= p_tolerancia),
      'minutos_tarde_total', coalesce(sum(a.minutos_diferencia)
        filter (where a.minutos_diferencia > p_tolerancia), 0),
      'peor', max(a.minutos_diferencia)
    ) as r
    from public.asistencias a
    join public.colaboradores c on c.id = a.colaborador_id
    where a.fecha between p_desde and p_hasta and a.minutos_diferencia is not null
    group by c.dni, c.nombre
    having count(*) filter (where a.minutos_diferencia > p_tolerancia) > 0
  ) y;

  return jsonb_build_object(
    'ok', true, 'desde', p_desde, 'hasta', p_hasta, 'tolerancia', p_tolerancia,
    'resumen', coalesce(v_resumen, '[]'::jsonb),
    'detalle', coalesce(v_detalle, '[]'::jsonb)
  );
end;
$function$;

grant execute on function public.sincronizar_nombres_programacion(jsonb) to authenticated;
grant execute on function public.asignar_dni_programacion(text, text, text) to authenticated;
grant execute on function public.programacion_de_marca(text, date, time, text) to authenticated;
grant execute on function public.reporte_puntualidad(date, date, integer) to authenticated;
