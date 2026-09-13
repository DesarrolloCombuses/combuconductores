-- La verificacion arranca el 1 de agosto de 2026: lo anterior no se revisa.
-- Antes el corte era el 15-jul-2026. Afecta a reporte_jornadas_anomalas
-- (Verificador de horarios / Fuera de horario) y a reporte_puntualidad.

create or replace function public.fecha_corte_verificacion()
returns date
language sql
immutable
as $function$
  select date '2026-08-01'
$function$;
