-- El corte del 1-ago-2026 se aplica ESTRICTAMENTE en las novedades nuevas.
--
-- fecha_corte_verificacion() ya lo respetaban reporte_desfases, reporte_puntualidad y
-- validacion_sin_programacion. Las dos novedades que se agregaron el 12-ago
-- (cierres_turno y jornadas_excedidas) no lo hacian, y por ahi se colaba julio.
--
-- Se colaba por la puerta de atras: la jornada se fecha por la SALIDA, asi que una
-- entrada del 28-jul cerrada el 2-ago entraba al reporte de agosto. Y son justo los
-- casos gordos -- entradas que quedaron abandonadas en julio:
--
--     ARIZA MARTINEZ ALEX YESID        28-jul 06:12 -> 02-ago 05:39   119,45 h
--     LEMOS SANCHEZ DIANNY KATERIENE   30-jul 23:12 -> 01-ago 15:04    39,87 h
--     CONTRERAS ROYETT GLENIS BEATRIZ  31-jul 14:20 -> 01-ago 14:48    24,46 h
--     BEDOYA TORO JULIAN               31-jul 15:11 -> 01-ago 15:17    24,10 h
--     CANO RODRIGUEZ MARIA CAMILA      31-jul 14:41 -> 01-ago 14:09    23,46 h
--
-- El error de esas cinco esta en julio, no en agosto: no hay a quien pedirle la
-- explicacion de una marca que nadie iba a revisar. Se quitan y no vuelven a entrar.
--
-- Regla, de aqui en adelante: una jornada se verifica solo si ENTRADA y SALIDA caen
-- del 1-ago-2026 en adelante. Con una sola pata en julio, no se evalua.

-- 1. Limpieza de lo que ya se habia colado.
delete from public.jornadas_excedidas
 where entrada_fecha < public.fecha_corte_verificacion();


-- 2. El trigger deja de crear novedades con la entrada en julio.
create or replace function public.detectar_jornada_excedida()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_ent public.asistencias%rowtype;
  v_horas numeric(6,2);
  v_lim numeric := public.limite_horas_jornada();
  v_corte date := public.fecha_corte_verificacion();
  v_dni text;
begin
  if new.sentido <> 'salida' then
    return new;
  end if;

  -- Corte estricto: ni la salida ni la entrada pueden ser anteriores al 1-ago-2026.
  if new.fecha < v_corte then
    return new;
  end if;

  select * into v_ent
    from public.asistencias e
   where e.colaborador_id = new.colaborador_id
     and e.sentido = 'entrada'
     and (e.fecha + e.hora)::timestamp < (new.fecha + new.hora)::timestamp
   order by (e.fecha + e.hora)::timestamp desc
   limit 1;

  if v_ent.id is null or v_ent.fecha < v_corte then
    return new;   -- sin entrada previa, o la jornada empezo antes del corte
  end if;

  v_horas := round(extract(epoch from
               ((new.fecha + new.hora)::timestamp - (v_ent.fecha + v_ent.hora)::timestamp)
             )::numeric / 3600, 2);

  if v_horas <= v_lim then
    return new;
  end if;

  select c.dni into v_dni from public.colaboradores c where c.id = new.colaborador_id;

  insert into public.jornadas_excedidas (
    entrada_id, salida_id, colaborador_id, dni,
    entrada_fecha, entrada_hora, salida_fecha, salida_hora,
    horas, limite_horas, exceso_horas, origen_salida
  ) values (
    v_ent.id, new.id, new.colaborador_id, v_dni,
    v_ent.fecha, v_ent.hora, new.fecha, new.hora,
    v_horas, v_lim, round(v_horas - v_lim, 2), new.origen
  )
  on conflict (salida_id) do nothing;

  return new;
exception when others then
  raise warning 'detectar_jornada_excedida: %', sqlerrm;
  return new;
end;
$function$;


-- 3. Los dos reportes nuevos recortan el rango al corte, igual que los de antes.
create or replace function public.reporte_jornadas_excedidas(
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
  v_tot jsonb;
  v_motivos jsonb;
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
      'limite', public.limite_horas_jornada(),
      'totales', jsonb_build_object('jornadas', 0, 'personas', 0,
                                    'sin_explicar', 0, 'rechazadas_buk', 0),
      'motivos', '[]'::jsonb, 'detalle', '[]'::jsonb);
  end if;

  -- Se suelta antes de crearla: si dos llamadas caen en la misma transaccion,
  -- 'on commit drop' todavia no la ha soltado y el create choca.
  drop table if exists _je;
  create temp table _je on commit drop as
  select je.*,
         c.nombre,
         coalesce(c.especialidad, '') as cargo,
         s.buk_error,
         s.enviado_buk,
         (s.buk_error ilike '%excedieron%') as rechazada_buk
    from public.jornadas_excedidas je
    join public.colaboradores c on c.id = je.colaborador_id
    left join public.asistencias s on s.id = je.salida_id
   where je.salida_fecha between v_desde and p_hasta
     and je.entrada_fecha >= v_corte;   -- la jornada completa dentro del corte

  select coalesce(jsonb_agg(x order by x.salida_fecha desc, x.horas desc), '[]'::jsonb)
    into v_detalle
    from (
      select entrada_fecha, to_char(entrada_hora, 'HH24:MI') as entrada_hora,
             salida_fecha,  to_char(salida_hora,  'HH24:MI') as salida_hora,
             horas, exceso_horas, limite_horas,
             dni, nombre, cargo, origen_salida,
             motivo, explicado_nombre,
             (motivo is null) as sin_explicar,
             to_char(explicado_at at time zone 'America/Bogota', 'YYYY-MM-DD HH24:MI') as explicado_at,
             rechazada_buk, enviado_buk, buk_error,
             salida_id, entrada_id
        from _je
    ) x;

  select coalesce(jsonb_agg(m order by m.veces desc), '[]'::jsonb)
    into v_motivos
    from (select coalesce(motivo, '(sin explicar)') as motivo, count(*)::int as veces
            from _je group by 1) m;

  select jsonb_build_object(
           'jornadas', count(*)::int,
           'personas', count(distinct colaborador_id)::int,
           'sin_explicar', count(*) filter (where motivo is null)::int,
           'rechazadas_buk', count(*) filter (where rechazada_buk)::int,
           'horas_max', max(horas),
           'horas_mediana', percentile_disc(0.5) within group (order by horas)
         )
    into v_tot
    from _je;

  return jsonb_build_object('ok', true, 'desde', v_desde, 'hasta', p_hasta,
                            'corte', v_corte, 'recortado', (v_desde > p_desde),
                            'limite', public.limite_horas_jornada(),
                            'totales', v_tot, 'motivos', v_motivos, 'detalle', v_detalle);
end;
$function$;

grant execute on function public.reporte_jornadas_excedidas(date, date) to authenticated;


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
      'totales', jsonb_build_object('cierres', 0, 'personas', 0, 'corregidos', 0),
      'motivos', '[]'::jsonb, 'detalle', '[]'::jsonb);
  end if;

  drop table if exists _ct;
  create temp table _ct on commit drop as
  select ct.*,
         c.nombre,
         coalesce(c.especialidad, '') as cargo,
         a.hora as salida_hora_actual,
         a.fecha as salida_fecha_actual
    from public.cierres_turno ct
    join public.colaboradores c on c.id = ct.colaborador_id
    left join public.asistencias a on a.id = ct.salida_id
   where ct.entrada_fecha between v_desde and p_hasta;

  select coalesce(jsonb_agg(x order by x.entrada_fecha desc, x.entrada_hora desc), '[]'::jsonb)
    into v_detalle
    from (
      select entrada_fecha, to_char(entrada_hora, 'HH24:MI') as entrada_hora,
             salida_fecha,
             to_char(hora_declarada, 'HH24:MI') as hora_declarada,
             to_char(hora_programada, 'HH24:MI') as hora_programada,
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

  return jsonb_build_object('ok', true, 'desde', v_desde, 'hasta', p_hasta,
                            'corte', v_corte, 'recortado', (v_desde > p_desde),
                            'totales', v_tot, 'motivos', v_motivos, 'detalle', v_detalle);
end;
$function$;

grant execute on function public.reporte_cierres_turno(date, date) to authenticated;
