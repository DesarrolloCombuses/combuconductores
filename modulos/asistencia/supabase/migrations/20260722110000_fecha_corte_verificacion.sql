-- Fecha de corte para las verificaciones de comportamiento (puntualidad y jornadas
-- fuera de horario): solo se evalua a partir de esta fecha; lo anterior se ignora.
-- Se centraliza aqui para cambiarla en un solo lugar.
-- (Distinta de FECHA_CORTE_VALIDACIONES = 2026-07-09, que rige la logica de turno
-- abierto/ultima marca en el front.)

create or replace function public.fecha_corte_verificacion()
returns date
language sql
immutable
as $function$
  select date '2026-07-15'
$function$;

grant execute on function public.fecha_corte_verificacion() to authenticated;
