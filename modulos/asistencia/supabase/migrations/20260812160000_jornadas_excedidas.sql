-- Jornadas que superan el maximo de horas que acepta Buk.
--
-- Es el rechazo #1 de Buk: "Las marcas excedieron el máximo de horas permitidas por
-- jornada", 190 veces entre el 1-jun y el 12-ago-2026 (~74 al mes). La marca queda en
-- nuestra base pero NO entra a nomina, y nadie se entera hasta que alguien revisa.
--
-- El limite NO es un numero elegido: sale de los datos. Pareando cada salida con su
-- entrada anterior (9.603 jornadas desde el 1-jun) el corte es exacto en 16 h:
--
--     duracion      jornadas   rechazadas por horas
--     < 12 h           8.052            0,1 %
--     12 - 14 h        1.071            0,3 %
--     14 - 15 h          191            1,0 %
--     15 - 16 h          104            3,8 %
--     16 - 17 h           26          100,0 %   <-- el corte
--     17 - 20 h           20           90,0 %
--     20 - 24 h           35           91,4 %
--     >= 24 h            104           84,6 %
--
-- Debajo de 16 h el rechazo es marginal; al pasar de 16 h fueron 26 de 26. Por eso el
-- limite queda en 16,0 h clavadas.
--
-- Como funciona:
--   1. Un trigger crea la novedad SIEMPRE que una salida cierre una jornada de mas de
--      16 h. No depende de que la app avise: si alguien registra por otra via, la
--      novedad igual queda. Nace con motivo NULL = "sin explicar".
--   2. La app obliga a explicarla antes de registrar y llama a explicar_jornada_excedida.
--   3. Lo que quede sin explicar se ve en Administracion, que es justamente el punto:
--      la brecha se mide, no se tapa.

create table if not exists public.jornadas_excedidas (
  id                uuid primary key default gen_random_uuid(),
  entrada_id        uuid references public.asistencias(id) on delete set null,
  salida_id         uuid not null references public.asistencias(id) on delete cascade,
  colaborador_id    uuid not null references public.colaboradores(id) on delete cascade,
  dni               text,
  entrada_fecha     date,
  entrada_hora      time,
  salida_fecha      date not null,
  salida_hora       time not null,
  horas             numeric(6,2) not null,
  limite_horas      numeric(4,1) not null default 16.0,
  exceso_horas      numeric(6,2) not null,
  origen_salida     text,            -- 'app', 'cierre_declarado', ...
  motivo            text,            -- NULL = todavia sin explicar
  explicado_por     uuid,
  explicado_nombre  text,
  explicado_at      timestamptz,
  created_at        timestamptz not null default now(),
  unique (salida_id)
);

create index if not exists jornadas_excedidas_fecha_idx     on public.jornadas_excedidas (salida_fecha);
create index if not exists jornadas_excedidas_colab_idx     on public.jornadas_excedidas (colaborador_id);
create index if not exists jornadas_excedidas_sinmotivo_idx on public.jornadas_excedidas (salida_fecha)
  where motivo is null;

alter table public.jornadas_excedidas enable row level security;

drop policy if exists jornadas_excedidas_lectura on public.jornadas_excedidas;
create policy jornadas_excedidas_lectura on public.jornadas_excedidas
  for select to authenticated using (true);

comment on table public.jornadas_excedidas is
  'Jornadas de mas de 16 h (limite de Buk). La crea un trigger; el motivo lo pone quien registra.';

-- Limite en un solo sitio: si Buk lo cambia, se cambia aqui y la app lo lee.
create or replace function public.limite_horas_jornada()
returns numeric
language sql
immutable
as $function$ select 16.0::numeric $function$;

grant execute on function public.limite_horas_jornada() to authenticated;


-- Trigger: toda salida que cierre una jornada de mas de 16 h deja novedad.
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
  v_dni text;
begin
  if new.sentido <> 'salida' then
    return new;
  end if;

  -- La entrada que esta salida cierra: la ultima anterior en el tiempo.
  select * into v_ent
    from public.asistencias e
   where e.colaborador_id = new.colaborador_id
     and e.sentido = 'entrada'
     and (e.fecha + e.hora)::timestamp < (new.fecha + new.hora)::timestamp
   order by (e.fecha + e.hora)::timestamp desc
   limit 1;

  if v_ent.id is null then
    return new;   -- salida sin entrada previa: es otro problema, no este
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
  -- Una novedad nunca puede impedir que se registre la marca.
  raise warning 'detectar_jornada_excedida: %', sqlerrm;
  return new;
end;
$function$;

drop trigger if exists trg_detectar_jornada_excedida on public.asistencias;
create trigger trg_detectar_jornada_excedida
  after insert on public.asistencias
  for each row execute function public.detectar_jornada_excedida();


-- Guarda la explicacion obligatoria de quien registro la marca.
create or replace function public.explicar_jornada_excedida(
  p_salida_id uuid,
  p_motivo text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_motivo text;
  v_quien text;
  v_row public.jornadas_excedidas%rowtype;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  v_motivo := nullif(btrim(coalesce(p_motivo, '')), '');
  if v_motivo is null or length(v_motivo) < 4 then
    return jsonb_build_object('ok', false, 'error', 'Falta la explicacion de la jornada extendida.');
  end if;

  select coalesce(pf.nombre, pr.full_name, split_part(u.email, '@', 1)) into v_quien
    from auth.users u
    left join public.perfiles pf on pf.user_id = u.id
    left join public.profiles pr on pr.id      = u.id
   where u.id = auth.uid();

  update public.jornadas_excedidas
     set motivo = v_motivo,
         explicado_por = auth.uid(),
         explicado_nombre = v_quien,
         explicado_at = now()
   where salida_id = p_salida_id
   returning * into v_row;

  if v_row.id is null then
    -- No es un error: significa que la jornada no supero el limite.
    return jsonb_build_object('ok', true, 'aplica', false);
  end if;

  return jsonb_build_object('ok', true, 'aplica', true,
    'horas', v_row.horas, 'exceso', v_row.exceso_horas, 'explicado_por', v_quien);
end;
$function$;

grant execute on function public.explicar_jornada_excedida(uuid, text) to authenticated;


-- Reporte para Administracion: jornadas pasadas de 16 h, con o sin explicacion.
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
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;
  if p_desde is null or p_hasta is null or p_desde > p_hasta then
    return jsonb_build_object('ok', false, 'error', 'Rango de fechas invalido.');
  end if;

  create temp table _je on commit drop as
  select je.*,
         c.nombre,
         coalesce(c.especialidad, '') as cargo,
         s.buk_error,
         s.enviado_buk,
         -- El rechazo de Buk por horas es el que esta novedad predice.
         (s.buk_error ilike '%excedieron%') as rechazada_buk
    from public.jornadas_excedidas je
    join public.colaboradores c on c.id = je.colaborador_id
    left join public.asistencias s on s.id = je.salida_id
   where je.salida_fecha between p_desde and p_hasta;

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

  return jsonb_build_object('ok', true, 'desde', p_desde, 'hasta', p_hasta,
                            'limite', public.limite_horas_jornada(),
                            'totales', v_tot, 'motivos', v_motivos, 'detalle', v_detalle);
end;
$function$;

grant execute on function public.reporte_jornadas_excedidas(date, date) to authenticated;


-- Carga inicial: las jornadas que YA se pasaron de 16 h desde la fecha de corte de las
-- verificaciones (1-ago-2026). Entran sin motivo, o sea "sin explicar": es el pasivo
-- real con el que arranca la pestaña, no un tablero en cero que no dice nada.
-- Es idempotente (unique en salida_id), asi que se puede volver a correr.
insert into public.jornadas_excedidas (
  entrada_id, salida_id, colaborador_id, dni,
  entrada_fecha, entrada_hora, salida_fecha, salida_hora,
  horas, limite_horas, exceso_horas, origen_salida
)
select e.id, s.id, s.colaborador_id, c.dni,
       e.fecha, e.hora, s.fecha, s.hora,
       round(extract(epoch from ((s.fecha + s.hora)::timestamp - (e.fecha + e.hora)::timestamp))::numeric / 3600, 2),
       public.limite_horas_jornada(),
       round(extract(epoch from ((s.fecha + s.hora)::timestamp - (e.fecha + e.hora)::timestamp))::numeric / 3600
             - public.limite_horas_jornada(), 2),
       s.origen
  from public.asistencias s
  join public.colaboradores c on c.id = s.colaborador_id
  join lateral (
    select e.*
      from public.asistencias e
     where e.colaborador_id = s.colaborador_id
       and e.sentido = 'entrada'
       and (e.fecha + e.hora)::timestamp < (s.fecha + s.hora)::timestamp
     order by (e.fecha + e.hora)::timestamp desc
     limit 1
  ) e on true
 where s.sentido = 'salida'
   and s.fecha >= public.fecha_corte_verificacion()
   and extract(epoch from ((s.fecha + s.hora)::timestamp - (e.fecha + e.hora)::timestamp)) / 3600
       > public.limite_horas_jornada()
on conflict (salida_id) do nothing;
