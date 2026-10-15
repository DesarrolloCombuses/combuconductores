/* ==========================================================================
   Gestores: el código QR firmado con la huella (o la cara) del celular
   --------------------------------------------------------------------------
   Los gestores se suben a los buses y el sensor de la puerta los cuenta como
   pasajeros. Para restarlos sin que nadie se haga pasar por otro:

   1. Activar (una vez, con internet): el celular del gestor crea una llave
      que NUNCA sale del teléfono y que solo se usa con la huella o la cara
      del dueño (WebAuthn, la misma tecnología de las "llaves de acceso").
      La parte pública va a Supabase con una selfie y un despachador la
      aprueba en el Portal de Control.
   2. Al subirse: el gestor pone la huella y el teléfono firma
      "CBG1|cédula|hora|número al azar". El QR lleva esa firma y sirve
      un minuto.
   3. El conductor lo lee: su celular revisa la firma con la parte pública
      del gestor (la tiene guardada, así que funciona sin internet), que el
      teléfono haya pedido la huella, que esté a tiempo y que no se haya usado.
   4. El programa de la tarjeta vuelve a revisar todo en el servidor (mismas
      reglas, en Python) antes de restar el pasajero.

   El código QR:  CBG1.<cédula>.<hora ms>.<al azar>.<authenticatorData>.<clientDataJSON>.<firma>
                  (los tres últimos en base64url, tal como los da el teléfono)

   Aquí solo está lo que no depende de la pantalla: crear la llave, firmar,
   leer y revisar. La pantalla está en portal.js.
   ========================================================================== */

(function (global) {
  "use strict";

  var PREFIJO = "CBG1";
  var MUESTRA_MS = 60 * 1000;          // el gestor lo muestra un minuto
  var VENCE_MS = 2 * 60 * 1000;        // el conductor lo acepta hasta 2 min después de firmado
  var ADELANTO_MS = 60 * 1000;         // un reloj adelantado hasta 1 min no lo daña

  var MOTIVOS = {
    no_es: "Eso no es un código de gestor.",
    no_aprobado: "Ese gestor no tiene un celular aprobado por control (o lo cambió hace poco).",
    firma: "El código no es válido: no lo firmó el celular aprobado del gestor.",
    otro_sitio: "El código no salió del Portal del Conductor.",
    sin_huella: "El código se hizo sin la huella o la cara del gestor.",
    vencido: "El código ya venció. Pídale que lo muestre otra vez.",
    reloj: "La hora de uno de los dos celulares está mal: revísela.",
    usado: "Ese código ya se leyó. Cada código sirve una sola vez.",
  };

  var codificar = new TextEncoder();
  var decodificar = new TextDecoder();

  // ------------------------------------------------------------- bytes
  function aB64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function deB64(texto) {
    var s = atob(texto);
    var bytes = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }

  function aB64url(bytes) {
    return aB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function deB64url(texto) {
    var s = String(texto).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return deB64(s);
  }

  function bytes(buffer) { return new Uint8Array(buffer); }

  function juntar(a, b) {
    var c = new Uint8Array(a.length + b.length);
    c.set(a, 0);
    c.set(b, a.length);
    return c;
  }

  function iguales(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function alAzar(n) { return crypto.getRandomValues(new Uint8Array(n)); }

  async function sha256(datos) { return bytes(await crypto.subtle.digest("SHA-256", datos)); }

  function mensaje(dni, t, nonce) { return codificar.encode(PREFIJO + "|" + dni + "|" + t + "|" + nonce); }

  // La firma de WebAuthn viene en DER; WebCrypto la quiere como r||s (32 + 32 bytes).
  function derACrudo(der) {
    try {
      if (der[0] !== 0x30) return null;
      var i = 2;
      if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
      var partes = [];
      for (var k = 0; k < 2; k++) {
        if (der[i] !== 0x02) return null;
        var largo = der[i + 1];
        var n = der.slice(i + 2, i + 2 + largo);
        while (n.length > 32 && n[0] === 0) n = n.slice(1);
        if (n.length > 32) return null;
        var lleno = new Uint8Array(32);
        lleno.set(n, 32 - n.length);
        partes.push(lleno);
        i += 2 + largo;
      }
      return juntar(partes[0], partes[1]);
    } catch (_) {
      return null;
    }
  }

  // ------------------------------------------------- ¿sirve este celular?
  // Hace falta WebAuthn con un "autenticador de plataforma": el lector de
  // huella o de cara del propio teléfono (y que tenga bloqueo de pantalla).
  async function sirveEsteCelular() {
    if (!global.isSecureContext || !global.PublicKeyCredential || !navigator.credentials || !global.crypto || !crypto.subtle) {
      return false;
    }
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (_) {
      return false;
    }
  }

  // ----------------------------------------------------- 1. activar
  // Pide la huella para crear la llave. Devuelve lo que se manda a Supabase.
  async function crearLlave(dni, nombre) {
    var cred = await navigator.credentials.create({
      publicKey: {
        challenge: alAzar(32),
        rp: { name: "Combuses - Gestores", id: location.hostname },
        user: { id: alAzar(16), name: "gestor-" + dni, displayName: nombre || "Gestor " + dni },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
          residentKey: "discouraged",
          requireResidentKey: false,
        },
        timeout: 120000,
        attestation: "none",
      },
    });
    var r = cred && cred.response;
    if (!r || typeof r.getPublicKey !== "function" || typeof r.getPublicKeyAlgorithm !== "function") {
      throw new Error("Este navegador es muy viejo para el código: actualice Chrome o Safari.");
    }
    var algoritmo = r.getPublicKeyAlgorithm();
    var spki = r.getPublicKey();
    if (algoritmo !== -7 || !spki) throw new Error("Este celular no sirve para el código (su llave no es ES256).");
    // Que de verdad se pueda usar para revisar firmas antes de mandarla.
    await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return { credencial: aB64url(bytes(cred.rawId)), llave: aB64(bytes(spki)), algoritmo: algoritmo };
  }

  // ----------------------------------------------------- 2. firmar
  // Pide la huella y devuelve el texto del QR.
  async function firmar(dni, credencial, ahora) {
    var t = Math.round(ahora || Date.now());
    var nonce = aB64url(alAzar(12));
    var reto = await sha256(mensaje(dni, t, nonce));
    var a = await navigator.credentials.get({
      publicKey: {
        challenge: reto,
        rpId: location.hostname,
        allowCredentials: [{ type: "public-key", id: deB64url(credencial) }],
        userVerification: "required",
        timeout: 60000,
      },
    });
    var r = a.response;
    return {
      texto: [PREFIJO, dni, String(t), nonce, aB64url(bytes(r.authenticatorData)),
              aB64url(bytes(r.clientDataJSON)), aB64url(bytes(r.signature))].join("."),
      t: t,
      nonce: nonce,
    };
  }

  // ----------------------------------------------------- 3. leer y revisar
  function leer(texto) {
    var p = String(texto || "").trim().split(".");
    if (p.length !== 7 || p[0] !== PREFIJO || !/^\d{5,15}$/.test(p[1]) || !/^\d{12,14}$/.test(p[2])) return null;
    try {
      return {
        texto: String(texto).trim(),
        dni: p[1],
        t: Number(p[2]),
        nonce: p[3],
        authData: deB64url(p[4]),
        clientData: deB64url(p[5]),
        firma: deB64url(p[6]),
      };
    } catch (_) {
      return null;
    }
  }

  // gestores: los aprobados [{dni, nombre, cargo, llave_publica, selfie...}]
  // opciones: { ahora, origen, rpId, usado: function(nonce) -> bool }
  // Devuelve { ok, motivo, texto, codigo, gestor }.
  async function revisar(texto, gestores, opciones) {
    opciones = opciones || {};
    var c = leer(texto);
    if (!c) return resultado(false, "no_es");
    var g = (gestores || []).find(function (x) { return String(x.dni) === c.dni; }) || null;
    if (!g) return resultado(false, "no_aprobado", c, null);

    var cd;
    try { cd = JSON.parse(decodificar.decode(c.clientData)); } catch (_) { return resultado(false, "firma", c, g); }
    var reto = aB64url(await sha256(mensaje(c.dni, c.t, c.nonce)));
    if (!cd || cd.type !== "webauthn.get" || cd.challenge !== reto) return resultado(false, "firma", c, g);
    var origen = opciones.origen || location.origin;
    if (cd.origin !== origen) return resultado(false, "otro_sitio", c, g);
    if (c.authData.length < 37) return resultado(false, "firma", c, g);
    var rpHash = await sha256(codificar.encode(opciones.rpId || location.hostname));
    if (!iguales(c.authData.slice(0, 32), rpHash)) return resultado(false, "otro_sitio", c, g);

    var crudo = derACrudo(c.firma);
    var bien = false;
    if (crudo) {
      try {
        var llave = await crypto.subtle.importKey("spki", deB64(g.llave_publica),
          { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
        bien = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, llave, crudo,
          juntar(c.authData, await sha256(c.clientData)));
      } catch (_) {
        bien = false;
      }
    }
    if (!bien) return resultado(false, "firma", c, g);

    var banderas = c.authData[32];
    if (!(banderas & 0x01) || !(banderas & 0x04)) return resultado(false, "sin_huella", c, g);  // presente y verificado

    var ahora = opciones.ahora || Date.now();
    if (c.t - ahora > ADELANTO_MS) return resultado(false, "reloj", c, g);
    if (ahora - c.t > VENCE_MS) return resultado(false, "vencido", c, g);
    if (opciones.usado && opciones.usado(c.nonce)) return resultado(false, "usado", c, g);
    return resultado(true, "ok", c, g);
  }

  function resultado(ok, motivo, codigo, gestor) {
    return {
      ok: ok,
      motivo: motivo,
      texto: ok ? "" : MOTIVOS[motivo] || motivo,
      codigo: codigo || null,
      gestor: gestor || null,
    };
  }

  global.GestoresQR = {
    PREFIJO: PREFIJO,
    MUESTRA_MS: MUESTRA_MS,
    VENCE_MS: VENCE_MS,
    MOTIVOS: MOTIVOS,
    sirveEsteCelular: sirveEsteCelular,
    crearLlave: crearLlave,
    firmar: firmar,
    leer: leer,
    revisar: revisar,
    // para las pruebas
    _derACrudo: derACrudo,
    _aB64url: aB64url,
    _deB64url: deB64url,
  };
})(window);
