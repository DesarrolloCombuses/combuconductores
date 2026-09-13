-- Cuando un conductor no aparece en la programacion, se busca en `novedades`.
--
-- La tabla `novedades` viene de la misma programacion y dice por que la persona no
-- tiene turno: DESCANSO, DISPONIBLE, INCAPACITADO, VACACIONES, RENUNCIA, etc. Hasta
-- ahora la app solo decia "sin programacion", que no explica nada y obliga a quien
-- registra a adivinar.
--
-- El cruce es POR NOMBRE, no por cedula: `novedades` no tiene dni. El orden de las
-- palabras no es estable entre las dos fuentes -- la programacion escribe
-- "YEPES ARISTIZABAL OLMER DUVAN" y novedades a veces "OLMER DUVAN YEPES ARISTIZABAL".
-- Por eso se cruza con normalizar_nombre_tokens(), que ademas de quitar tildes y
-- mayusculas ordena las palabras alfabeticamente. Medido sobre los 135 nombres de
-- novedades desde el 1-ago:
--
--     comparando el texto tal cual        120 / 135   (89 %)
--     normalizando con tokens             130 / 135   (96 %)
--
-- Los 5 que no cruzan de ninguna forma no estan en `colaboradores`, asi que tampoco
-- pueden marcar asistencia: no afectan este caso de uso.
--
-- Lo que aparece al cruzar es el motivo por el que esto hacia falta. De 526 dias-persona
-- con marca pero sin programacion en agosto, 82 SI tenian novedad:
--
--     DESCANSO                 72 veces   64 personas   <-- marcando en su dia libre
--     DISPONIBLE                7           7
--     PENDIENTE                 1           1
--     RECONOCIMIENTO DE RUTA    1           1
--     VACACIONES                1           1           <-- marco estando de vacaciones
--
-- Estados incompatibles con estar trabajando. Se clasifican para que la app sepa
-- cuando avisar fuerte y cuando solo informar.
create or replace function public.novedad_bloquea_labor(p_estado text)
returns boolean
language sql
immutable
as $function$
  select public.normalizar_nombre(p_estado) in
    ('INCAPACITADO', 'VACACIONES', 'RENUNCIA', 'CALAMIDAD',
     'PERMISO', 'DIA NO REMUNERADO', 'LICENCIA', 'SUSPENDIDO')
$function$;

grant execute on function public.novedad_bloquea_labor(text) to authenticated;


-- Novedad de una persona en una fecha, resolviendo el nombre desde la cedula.
-- Busca por dos caminos, en este orden:
--   1. El nombre en `colaboradores` (es el que tiene la cedula).
--   2. El nombre con el que aparece en la programacion, via el puente
--      `programacion_conductor_dni`, por si en colaboradores esta escrito distinto.
create or replace function public.novedad_conductor_dia(
  p_dni text,
  p_fecha date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_nom_colab text;
  v_nom_prog text;
  v_row record;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;
  if p_dni is null or p_fecha is null then
    return jsonb_build_object('ok', true, 'existe', false);
  end if;

  select public.normalizar_nombre_tokens(c.nombre) into v_nom_colab
    from public.colaboradores c where c.dni = p_dni;

  select public.normalizar_nombre_tokens(m.nombre_programacion) into v_nom_prog
    from public.programacion_conductor_dni m where m.dni = p_dni limit 1;

  if v_nom_colab is null and v_nom_prog is null then
    return jsonb_build_object('ok', true, 'existe', false, 'motivo', 'sin_nombre');
  end if;

  select n.estado, n.base, n.nombre, n.fecha, n.updated_at
    into v_row
    from public.novedades n
   where n.fecha = p_fecha
     and public.normalizar_nombre_tokens(n.nombre) in (v_nom_colab, v_nom_prog)
   order by n.updated_at desc
   limit 1;

  if v_row.estado is null then
    return jsonb_build_object('ok', true, 'existe', false);
  end if;

  return jsonb_build_object(
    'ok', true,
    'existe', true,
    'estado', v_row.estado,
    'base', v_row.base,
    'nombre_novedad', v_row.nombre,
    'fecha', v_row.fecha,
    'bloquea', public.novedad_bloquea_labor(v_row.estado),
    'actualizado', to_char(v_row.updated_at at time zone 'America/Bogota', 'YYYY-MM-DD HH24:MI')
  );
end;
$function$;

grant execute on function public.novedad_conductor_dia(text, date) to authenticated;


-- obtener_programacion_dia devuelve ahora la novedad cuando no hay turno, para que
-- el aviso de la app pueda decir POR QUE no lo hay en vez de solo "sin programacion".
-- Se conserva TAL CUAL lo que ya hacia (misma firma sin default, normalizacion de la
-- cedula, orden por hora_entrada); lo unico nuevo es el campo `novedad`.
create or replace function public.obtener_programacion_dia(p_dni text, p_fecha date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_dni text;
  v_turnos jsonb;
  v_novedad jsonb;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  v_dni := regexp_replace(coalesce(p_dni, ''), '[^0-9]', '', 'g');
  if v_dni = '' then
    return jsonb_build_object('ok', false, 'error', 'Cedula vacia.');
  end if;

  select jsonb_agg(jsonb_build_object(
           'turno', t.turno,
           'hora_entrada', to_char(t.hora_entrada, 'HH24:MI'),
           'hora_salida', to_char(t.hora_salida, 'HH24:MI'),
           'vehiculo', t.vehiculo,
           'base', t.base,
           'puesto', t.puesto
         ) order by t.hora_entrada)
    into v_turnos
    from public.programacion_turnos t
   where t.dni = v_dni and t.fecha = p_fecha;

  -- Sin turno: se mira `novedades`, que es la otra cara de la misma programacion.
  if v_turnos is null then
    v_novedad := public.novedad_conductor_dia(v_dni, p_fecha);
  end if;

  return jsonb_build_object(
    'ok', true,
    'existe', v_turnos is not null,
    'fecha', p_fecha,
    'turnos', coalesce(v_turnos, '[]'::jsonb),
    'novedad', case when v_novedad is not null and (v_novedad->>'existe')::boolean
                    then v_novedad else null end
  );
end;
$function$;

grant execute on function public.obtener_programacion_dia(text, date) to authenticated;


-- Reporte para Administracion: quien marco asistencia teniendo una novedad ese dia.
-- Marcar estando en DESCANSO puede ser legitimo (le pidieron cubrir un turno), pero
-- tiene que quedar visible; marcar estando INCAPACITADO o de VACACIONES no lo es.
create or replace function public.reporte_marcas_con_novedad(
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
  v_estados jsonb;
  v_tot jsonb;
  v_corte date := public.fecha_corte_verificacion();
  v_desde date;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;
  if p_desde is null or p_hasta is null or p_desde > p_hasta then
    return jsonb_build_object('ok', false, 'error', 'Rango de fechas invalido.');
  end if;

  v_desde := greatest(p_desde, v_corte);
  if p_hasta < v_corte then
    return jsonb_build_object('ok', true, 'desde', v_desde, 'hasta', p_hasta,
      'corte', v_corte, 'recortado', true,
      'totales', jsonb_build_object('dias', 0, 'personas', 0, 'incompatibles', 0),
      'estados', '[]'::jsonb, 'detalle', '[]'::jsonb);
  end if;

  drop table if exists _mn;
  create temp table _mn on commit drop as
  with dias as (
    select a.fecha, c.id as colaborador_id, c.dni, c.nombre,
           coalesce(c.especialidad, '') as cargo,
           public.normalizar_nombre_tokens(c.nombre) as nom_tok,
           min(a.hora) filter (where a.sentido = 'entrada') as primera_entrada,
           max(a.hora) filter (where a.sentido = 'salida')  as ultima_salida,
           count(*)::int as marcas
      from public.asistencias a
      join public.colaboradores c on c.id = a.colaborador_id
     where a.fecha between v_desde and p_hasta
     group by 1, 2, 3, 4, 5, 6
  )
  select d.*, n.estado, n.base as base_novedad,
         public.novedad_bloquea_labor(n.estado) as incompatible,
         exists (select 1 from public.programacion_turnos p
                  where p.dni = d.dni and p.fecha = d.fecha) as tenia_programacion
    from dias d
    join public.novedades n
      on n.fecha = d.fecha
     and public.normalizar_nombre_tokens(n.nombre) = d.nom_tok;

  select coalesce(jsonb_agg(x order by x.incompatible desc, x.fecha desc, x.nombre), '[]'::jsonb)
    into v_detalle
    from (
      select fecha, dni, nombre, cargo, estado, base_novedad, incompatible,
             tenia_programacion, marcas,
             to_char(primera_entrada, 'HH24:MI') as entrada,
             to_char(ultima_salida, 'HH24:MI') as salida
        from _mn
    ) x;

  select coalesce(jsonb_agg(e order by e.veces desc), '[]'::jsonb)
    into v_estados
    from (select estado, count(*)::int as veces,
                 count(distinct dni)::int as personas,
                 bool_or(incompatible) as incompatible
            from _mn group by estado) e;

  select jsonb_build_object(
           'dias', count(*)::int,
           'personas', count(distinct dni)::int,
           'incompatibles', count(*) filter (where incompatible)::int,
           'con_programacion', count(*) filter (where tenia_programacion)::int
         )
    into v_tot
    from _mn;

  return jsonb_build_object('ok', true, 'desde', v_desde, 'hasta', p_hasta,
                            'corte', v_corte, 'recortado', (v_desde > p_desde),
                            'totales', v_tot, 'estados', v_estados, 'detalle', v_detalle);
end;
$function$;

grant execute on function public.reporte_marcas_con_novedad(date, date) to authenticated;
