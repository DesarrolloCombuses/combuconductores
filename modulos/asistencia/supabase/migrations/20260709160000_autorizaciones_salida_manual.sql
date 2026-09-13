-- Auditoria y autorizacion de la "Salida por incapacidad o ausencia".
-- Cada salida manual debe pasar por un codigo dinamico de un solo uso generado
-- desde Supabase, ademas de dejar registro de QUIEN la hizo (usuario logueado),
-- la UBICACION del que registra y la FOTO (selfie del lider). Esto blinda el
-- punto mas debil del sistema (la salida manual, con hora editable) contra fraude.
--
-- Flujo:
--   1) generar_codigo_salida_manual(dni, motivo) -> crea el codigo y lo muestra.
--   2) validar_codigo_salida_manual(id, codigo)  -> chequea antes de registrar.
--   3) consumir_codigo_salida_manual(id, codigo, ubicacion, foto, ids) -> marca
--      usado y guarda toda la evidencia. Un codigo solo sirve una vez y vence en 5 min.
--
-- Por ahora cualquier usuario autenticado puede generar/usar un codigo. Cuando se
-- defina la lista de quien puede y quien no, se agrega el chequeo dentro de
-- generar_codigo_salida_manual (una sola linea).

create table if not exists public.autorizaciones_salida_manual (
  id             uuid primary key default gen_random_uuid(),
  creado_en      timestamptz not null default now(),
  usuario_id     uuid not null,           -- QUIEN lo hizo (auth.uid del lider logueado)
  usuario_email  text,                    -- correo del lider (para lectura rapida)
  colaborador_dni text,                   -- conductor al que se le registra la salida
  colaborador_id text,                    -- id interno del colaborador (como texto, sin acoplar tipos)
  asistencia_id  text,                    -- id de la marca de salida creada
  motivo         text,
  codigo         text not null,           -- codigo dinamico de un solo uso
  vence_en       timestamptz not null,
  usado          boolean not null default false,
  usado_en       timestamptz,
  latitud        double precision,        -- UBICACION del lider que registra
  longitud       double precision,
  precision_m    double precision,
  foto_path      text                     -- selfie del lider en Storage
);

create index if not exists idx_autoriz_salida_usuario
  on public.autorizaciones_salida_manual (usuario_id, creado_en desc);

-- 1) Genera el codigo dinamico y devuelve {id, codigo, vence_en}.
create or replace function public.generar_codigo_salida_manual(
  p_colaborador_dni text,
  p_motivo text
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_email text;
  v_codigo text;
  v_id    uuid;
  v_vence timestamptz;
begin
  if v_user is null then
    raise exception 'No autenticado' using errcode = 'P0001';
  end if;

  -- (Futuro) lista blanca: aqui se validara si v_user/ v_email puede o no.

  select email into v_email from auth.users where id = v_user;

  v_codigo := lpad((floor(random() * 1000000))::int::text, 6, '0');
  v_vence  := now() + interval '5 minutes';

  insert into public.autorizaciones_salida_manual (
    usuario_id, usuario_email, colaborador_dni, motivo, codigo, vence_en
  ) values (
    v_user, v_email, p_colaborador_dni, p_motivo, v_codigo, v_vence
  ) returning id into v_id;

  return json_build_object('id', v_id, 'codigo', v_codigo, 'vence_en', v_vence);
end;
$$;

-- 2) Valida el codigo sin consumirlo (chequeo previo a registrar la salida).
create or replace function public.validar_codigo_salida_manual(
  p_id uuid,
  p_codigo text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_row  public.autorizaciones_salida_manual;
begin
  if v_user is null then
    raise exception 'No autenticado' using errcode = 'P0001';
  end if;

  select * into v_row from public.autorizaciones_salida_manual where id = p_id;

  if not found then
    raise exception 'Codigo no encontrado' using errcode = 'P0001';
  end if;
  if v_row.usuario_id <> v_user then
    raise exception 'El codigo pertenece a otro usuario' using errcode = 'P0001';
  end if;
  if v_row.usado then
    raise exception 'El codigo ya fue usado' using errcode = 'P0001';
  end if;
  if now() > v_row.vence_en then
    raise exception 'El codigo esta vencido' using errcode = 'P0001';
  end if;
  if v_row.codigo <> p_codigo then
    raise exception 'Codigo incorrecto' using errcode = 'P0001';
  end if;

  return true;
end;
$$;

-- 3) Consume el codigo (un solo uso) y guarda toda la evidencia.
create or replace function public.consumir_codigo_salida_manual(
  p_id uuid,
  p_codigo text,
  p_latitud double precision,
  p_longitud double precision,
  p_precision_m double precision,
  p_foto_path text,
  p_colaborador_id text,
  p_asistencia_id text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_row  public.autorizaciones_salida_manual;
begin
  if v_user is null then
    raise exception 'No autenticado' using errcode = 'P0001';
  end if;

  select * into v_row from public.autorizaciones_salida_manual where id = p_id for update;

  if not found then
    raise exception 'Codigo no encontrado' using errcode = 'P0001';
  end if;
  if v_row.usuario_id <> v_user then
    raise exception 'El codigo pertenece a otro usuario' using errcode = 'P0001';
  end if;
  if v_row.usado then
    raise exception 'El codigo ya fue usado' using errcode = 'P0001';
  end if;
  if now() > v_row.vence_en then
    raise exception 'El codigo esta vencido' using errcode = 'P0001';
  end if;
  if v_row.codigo <> p_codigo then
    raise exception 'Codigo incorrecto' using errcode = 'P0001';
  end if;

  update public.autorizaciones_salida_manual set
    usado          = true,
    usado_en       = now(),
    latitud        = p_latitud,
    longitud       = p_longitud,
    precision_m    = p_precision_m,
    foto_path      = p_foto_path,
    colaborador_id = p_colaborador_id,
    asistencia_id  = p_asistencia_id
  where id = p_id;

  return true;
end;
$$;

-- RLS: acceso directo a la tabla solo de lectura; escrituras solo via las
-- funciones SECURITY DEFINER de arriba.
alter table public.autorizaciones_salida_manual enable row level security;

drop policy if exists sel_autorizaciones_salida on public.autorizaciones_salida_manual;
create policy sel_autorizaciones_salida on public.autorizaciones_salida_manual
  for select to authenticated using (true);

grant execute on function public.generar_codigo_salida_manual(text, text) to authenticated;
grant execute on function public.validar_codigo_salida_manual(uuid, text) to authenticated;
grant execute on function public.consumir_codigo_salida_manual(uuid, text, double precision, double precision, double precision, text, text, text) to authenticated;
