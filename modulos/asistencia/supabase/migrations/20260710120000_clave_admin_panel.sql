-- Protege el panel de Administración con una CLAVE verificada en el servidor.
-- La clave real NO queda en el código: se guarda en Vault (secret 'clave_admin_panel').
-- Esta función solo compara la clave enviada contra la de Vault y devuelve true/false,
-- así el navegador nunca conoce la clave. Solo usuarios autenticados pueden intentar.
--
-- PASO MANUAL (crear/cambiar la clave):
--   select vault.create_secret('LA-CLAVE', 'clave_admin_panel', 'Clave del panel Admin');
--   -- para cambiarla:
--   update vault.secrets set secret = 'NUEVA' where name = 'clave_admin_panel';

create or replace function public.verificar_clave_admin(p_clave text)
returns boolean
language plpgsql
security definer
set search_path = public, vault
as $function$
declare
  v_clave text;
begin
  if auth.uid() is null then
    return false;
  end if;

  select decrypted_secret
    into v_clave
  from vault.decrypted_secrets
  where name = 'clave_admin_panel'
  limit 1;

  if v_clave is null then
    return false; -- clave no configurada: nadie entra hasta crearla en Vault
  end if;

  return p_clave = v_clave;
end;
$function$;

grant execute on function public.verificar_clave_admin(text) to authenticated;
