-- Vigilancia antifraude: conductores cuya asistencia la registra casi siempre un
-- administrador (admin_form/manual) y que casi nunca marcan ellos mismos de forma
-- biometrica (web/movil). Devuelve la agregacion por colaborador en una ventana de
-- dias, para una vista de control continua.

create or replace function public.conductores_sin_marca_propia(
  p_dias int default 90,
  p_max_bio int default 1
)
returns table(
  dni text,
  nombre text,
  cargo text,
  total bigint,
  reg_admin bigint,
  biometricas bigint,
  pct_admin int,
  ultima_marca date
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.dni::text as dni,
    c.nombre::text as nombre,
    coalesce(c.especialidad, '')::text as cargo,
    count(*) as total,
    count(*) filter (where a.origen in ('admin_form','manual','manual_pendiente')) as reg_admin,
    count(*) filter (where a.origen in ('web','movil_sin_foto')) as biometricas,
    round(100.0 * count(*) filter (where a.origen in ('admin_form','manual','manual_pendiente')) / count(*))::int as pct_admin,
    max(a.fecha) as ultima_marca
  from public.asistencias a
  join public.colaboradores c on c.id = a.colaborador_id
  where a.fecha >= current_date - p_dias
  group by c.dni, c.nombre, c.especialidad
  having count(*) >= 5
     and count(*) filter (where a.origen in ('web','movil_sin_foto')) <= p_max_bio
  order by biometricas asc, reg_admin desc;
$$;

grant execute on function public.conductores_sin_marca_propia(int, int) to authenticated;
