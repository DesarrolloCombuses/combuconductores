/* ==========================================================================
   Modo portal - módulo de asistencia biométrica

   Se carga siempre, pero solo actúa si la URL trae ?embed=portal, que es como
   el Portal del Conductor embebe este módulo. Abierto normalmente no toca nada.

   Lo estático lo resuelve modo-portal.css; aquí va únicamente lo que el CSS no
   puede hacer: poner el atributo que activa esas reglas y avisar al portal
   cuando se registra una marca, para que refresque su resumen de jornada.

   El autologin por postMessage NO se implementa aquí: asistencia.js ya lo trae
   (setupEmbeddedAutoLogin) y el portal habla ese mismo protocolo.
   ========================================================================== */

(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  if (params.get("embed") !== "portal") return;

  // Cuanto antes, para que el CSS aplique sin parpadeo: este script va en el
  // <head>, justo después de la hoja de estilos.
  document.documentElement.setAttribute("data-embed", "portal");

  // ¿Heredamos sesión del portal? Portal e iframe son del mismo origen, así
  // que comparten localStorage, donde supabase-js guarda la sesión bajo una
  // clave sb-<ref>-auth-token. Sin ella dejamos visible el login del módulo
  // (ver modo-portal.css) en vez de mostrar un hueco vacío.
  function haySesionHeredada() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf("sb-") === 0 && k.indexOf("-auth-token") > 0) return true;
      }
    } catch (_) {
      // Almacenamiento bloqueado: no podemos afirmar que haya sesión.
      return false;
    }
    return false;
  }

  if (!haySesionHeredada()) {
    document.documentElement.setAttribute("data-sesion", "no");
  }

  // --- Cédula elegida en el portal ---
  // El conductor ya se identificó en el portal tocando su turno en la
  // programación: no tiene sentido hacerle teclear la cédula otra vez. El
  // portal la manda por postMessage; aquí se escribe en el paso 1 y se dispara
  // la misma validación que dispara el teclado. Lo demás (foto, ubicación,
  // vehículo programado) sigue su curso normal en asistencia.js.
  var conductorPortal = null;
  var dniPrecargado = "";
  var temporizadorPrecarga = null;

  function soloDigitos(v) { return String(v == null ? "" : v).replace(/\D/g, ""); }

  // Devuelve true cuando ya no hay nada pendiente.
  function precargarCedula() {
    if (!conductorPortal || !conductorPortal.dni) return true;

    var appView = document.getElementById("appView");
    var input = document.getElementById("dniInput");
    // La app se muestra cuando la sesión quedó aplicada; antes no hay nada
    // que validar.
    if (!appView || !input || appView.classList.contains("hidden")) return false;

    var dni = soloDigitos(conductorPortal.dni);
    var actual = soloDigitos(input.value);
    if (actual === dni) return true;

    // Si alguien escribió otra cédula a mano no se la pisamos: solo se llena
    // un campo vacío o uno que habíamos llenado nosotros.
    if (actual && actual !== dniPrecargado) return true;

    input.value = dni;
    dniPrecargado = dni;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  function programarPrecarga() {
    clearInterval(temporizadorPrecarga);
    if (precargarCedula()) return;
    var intentos = 0;
    temporizadorPrecarga = setInterval(function () {
      if (precargarCedula() || ++intentos > 150) clearInterval(temporizadorPrecarga);
    }, 400);
  }

  window.addEventListener("message", function (event) {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.type !== "PORTAL_CONDUCTOR") return;
    conductorPortal = data.payload || null;
    programarPrecarga();
  });

  // Por si el portal mandó los datos antes de que este documento escuchara.
  try {
    window.parent.postMessage({ type: "PORTAL_PEDIR_CONDUCTOR" }, window.location.origin);
  } catch (_) {}

  // El portal muestra en su Inicio las marcas del día. Cuando aquí se registra
  // una, ese resumen queda viejo: se lo avisamos para que lo recargue.
  // asistencia.js enseña el overlay #registroSuccessOverlay al terminar bien un
  // registro, así que observamos ese cambio en vez de tocar su código.
  function avisarMarcaRegistrada() {
    try {
      window.parent.postMessage({ type: "PORTAL_MARCA_REGISTRADA" }, window.location.origin);
    } catch (_) { /* el portal no está escuchando: no pasa nada */ }
  }

  function observarRegistros() {
    var overlay = document.getElementById("registroSuccessOverlay");
    if (!overlay || typeof MutationObserver === "undefined") return;

    var visibleAntes = !overlay.classList.contains("hidden");

    new MutationObserver(function () {
      var visibleAhora = !overlay.classList.contains("hidden");
      // Solo en el flanco oculto -> visible: así no avisamos al cerrarlo.
      if (visibleAhora && !visibleAntes) avisarMarcaRegistrada();
      visibleAntes = visibleAhora;
    }).observe(overlay, { attributes: true, attributeFilter: ["class"] });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observarRegistros, { once: true });
  } else {
    observarRegistros();
  }
})();
