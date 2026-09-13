const config = window.APP_CONFIG || {};
const hasConfig = Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY && !config.SUPABASE_URL.includes("PEGA_AQUI"));
const supabaseClient = hasConfig
  ? window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY)
  : null;
const BUK_OBRA_ID = 39305;
const SONAR_ASSIGN_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbwjWOleTmh7hMK93tq4W7zJI_2IdpYN2NBitYLK77pswDj52B2U0W6vthkTrONFmVtWtQ/exec";
const FACE_FALLBACK_DELAY_MS = 5000;
const FACE_IMAGE_CHECK_TIMEOUT_MS = 4500;
const FACE_IDENTITY_TIMEOUT_MS = 6500;

// Fecha de corte: la logica de "ultima marca / turno abierto" solo considera
// marcas de esta fecha en adelante. Asi los turnos viejos (anteriores) no se
// arrastran al flujo y empezamos limpio desde el 9 de julio de 2026.
const FECHA_CORTE_VALIDACIONES = "2026-07-09";

// TEMPORAL (pruebas): muestra el boton "Eliminar" en cada marca del panel de
// Administracion para poder borrar marcas de prueba. Poner en false para
// ocultarlo cuando terminen las pruebas.
const HABILITAR_ELIMINAR_MARCAS = true;

const $ = (selector) => document.querySelector(selector);

function detectDeviceMode() {
  const ancho = window.innerWidth || document.documentElement.clientWidth || 0;
  const ua = navigator.userAgent || "";
  const punteroGrueso = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  const tieneTouch = (navigator.maxTouchPoints || 0) > 0 || punteroGrueso;
  const uaMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const esEstrecho = ancho < 820;

  if (uaMobile || (tieneTouch && esEstrecho)) return "mobile";
  if (esEstrecho) return "narrow";
  return "desktop";
}

function applyDeviceMode() {
  const modo = detectDeviceMode();
  const root = document.documentElement;
  root.dataset.deviceMode = modo;
  root.classList.toggle("is-mobile", modo === "mobile");
  root.classList.toggle("is-narrow", modo === "narrow");
  root.classList.toggle("is-desktop", modo === "desktop");
  root.classList.toggle("touch-device", modo === "mobile" || modo === "narrow");
  try { state.deviceMode = modo; } catch (_) { /* state aun no definido en el primer call */ }
  updateDeviceModeBadge(modo);
  return modo;
}

function updateDeviceModeBadge(modo) {
  const badge = document.getElementById("deviceModeBadge");
  if (!badge) return;
  const label = modo === "mobile" ? "Movil" : modo === "narrow" ? "Web compacta" : "Web";
  const icon = modo === "mobile" ? "smartphone" : "monitor";
  badge.dataset.mode = modo;
  badge.title = `Modo de visualizacion: ${label} (${window.innerWidth}px)`;
  badge.innerHTML = `<i data-lucide="${icon}"></i><span>${label}</span>`;
  if (window.lucide?.createIcons) {
    try { window.lucide.createIcons({ icons: window.lucide.icons }); } catch (_) {}
  }
}

applyDeviceMode();
window.addEventListener("resize", () => { applyDeviceMode(); if (typeof applyTabVisibility === "function") applyTabVisibility(); });
window.addEventListener("orientationchange", () => { applyDeviceMode(); if (typeof applyTabVisibility === "function") applyTabVisibility(); });

const state = {
  deviceMode: detectDeviceMode(),
  user: null,
  colaborador: null,
  csvCandidate: null,
  // Agenda de celulares para el comprobante por WhatsApp (tabla contactos_whatsapp).
  celularAgendaDni: "",
  celularAgendaGuardado: "",
  celularAgendaPreguntado: "",
  celularAgendaPreguntando: false,
  // Programacion de turnos del dia (tabla programacion_turnos vía RPC).
  programacionHoy: null,
  programacionAvisoVehiculo: "",
  programacionAvisoHorario: "",
  // Sentido que sugiere el HORARIO programado (manda sobre la ultima marca).
  sentidoSegunProgramacion: null,
  sentidoForzadoManual: false,
  // Motivo que digita quien registra cuando la marca no concuerda con el horario
  // (p.ej. "estaba en el taller"). Se guarda en la observacion de la marca.
  motivoDesfase: "",
  motivoJornadaExtendida: "",
  novedadHoy: null,
  horasJornadaExtendida: null,
  // Estado del turno programado que corresponde a este momento (RPC estado_turno_actual).
  // Si viene `completa`, la jornada ya se cumplio y NO se admite otra marca.
  turnoEstado: null,
  puntualidadLoaded: false,
  jornadasLoaded: false,
  jornadasData: null,
  jornadasFiltro: "",
  verificadorLoaded: false,
  verificadorData: null,
  verificadorFiltro: "",
  // "errores" (rango) | "dia" (consolidado del día) | "desfases" (anticipos/excesos)
  // | "gestores" (personal sin programación) | "cierres" (bitácora de cierres declarados)
  verificadorModo: "errores",
  verificadorDiaData: null,
  verificadorDesfasesData: null,
  verificadorGestoresData: null,
  verificadorCierresData: null,
  verificadorExcedidasData: null,
  verificadorNovedadesData: null,
  // Turno anterior sin cerrar que hay que declarar antes de admitir la ENTRADA de hoy.
  cierrePendiente: null,
  horarioLoaded: false,
  horarioFilas: [],
  base3Loaded: false,
  base3Filas: [],
  mapaLoaded: false,
  mapaMap: null,
  mapaLayer: null,
  // Fecha de corte de las verificaciones: no se evalua nada anterior.
  // Debe coincidir con fecha_corte_verificacion() en la base: no se revisa nada anterior.
  fechaCorteVerificacion: "2026-08-01",
  compressedFile: null,
  faceValidated: false,
  faceWarning: "",
  currentLocation: null,
  isDriverCandidate: false,
  nextSentido: "entrada",
  currentHistory: [],
  historyPage: 1,
  historyPageSize: 10,
  historyTotal: 0,
  vehicles: [],
  vehiclesLoaded: false,
  attendanceSonarDriver: null,
  lastAttendance: null,
  lastEntrada: null,
  openEntrada: null,
  submittingMark: false,
  submitInFlight: false,
  photoModalRequestSeq: 0,
  identidadConfirmada: false,
  avisarAdminSentido: false,
  perfilSocioLoaded: false,
  perfilSocioRows: [],
  overdueToastDismissed: false,
  overdueToastDismissedIds: [],
  adminSubtab: "alerts",
  openTurns: [],
  overdueDriversCount: 0,
  sentidoRevisionRows: [],
  sentidoRevisionCount: 0,
  selectedSonarDriverId: null,
  cameraStream: null,
  cameraOpenedAt: 0,
  cameraFallbackTimer: null,
  liveDetectionRunning: false,
  liveFaceOk: false,
  serverClock: null,
  serverClockTimer: null,
  serverClockResyncTimer: null,
  reportDateTouched: false,
  reportTimeTouched: false,
  csvRows: [],
  csvLoaded: false,
  dniValidationTimer: null,
  visionTasks: null,
  faceDetector: null,
  faceDetectorReady: false,
  faceApiReady: false,
  isAdmin: false,
  adminMarks: [],
  adminFilteredMarks: [],
  adminPage: 1,
  adminPageSize: 15,
  sonarDrivers: [],
  cameraMode: "attendance",
  enrollCandidate: null,
  enrollColaborador: null,
  manualAuthId: null,
  manualLocation: null,
  manualSelfieBlob: null,
  manualCameraStream: null,
  journalMarks: [],
  journalFiltered: [],
  journalPage: 1,
  journalPageSize: 15,
  journalLoaded: false,
  rechazoMarks: [],
  rechazoFiltered: [],
  rechazoPage: 1,
  rechazoPageSize: 15,
  rechazoLoaded: false,
  inconsistMarks: [],
  inconsistRows: [],
  inconsistLoaded: false,
  sinMarcaRows: [],
  sinMarcaLoaded: false,
  validacionRows: [],
  validacionLoaded: false
};

const elements = {
  loginView: $("#loginView"),
  appView: $("#appView"),
  registerTabButton: $("#registerTabButton"),
  historyTabButton: $("#historyTabButton"),
  base3TabButton: $("#base3TabButton"),
  adminTabButton: $("#adminTabButton"),
  manualExitTabButton: $("#manualExitTabButton"),
  adminTabBadge: $("#adminTabBadge"),
  adminSubtabs: $("#adminSubtabs"),
  adminSubtabAlertsBadge: $("#adminSubtabAlertsBadge"),
  overdueDriversToast: $("#overdueDriversToast"),
  overdueDriversToastTitle: $("#overdueDriversToastTitle"),
  overdueDriversToastList: $("#overdueDriversToastList"),
  overdueDriversToastClose: $("#overdueDriversToastClose"),
  overdueDriversToastGo: $("#overdueDriversToastGo"),
  registerPanel: $("#registerPanel"),
  historyPanel: $("#historyPanel"),
  base3Panel: $("#base3Panel"),
  adminPanel: $("#adminPanel"),
  manualExitPanel: $("#manualExitPanel"),
  loginForm: $("#loginForm"),
  loginMessage: $("#loginMessage"),
  emailInput: $("#emailInput"),
  passwordInput: $("#passwordInput"),
  userLabel: $("#userLabel"),
  connectionStatus: $("#connectionStatus"),
  logoutButton: $("#logoutButton"),
  attendanceForm: $("#attendanceForm"),
  dniInput: $("#dniInput"),
  searchButton: $("#searchButton"),
  collaboratorBox: $("#collaboratorBox"),
  driverGreetingCard: $("#driverGreetingCard"),
  turnoStatusBanner: $("#turnoStatusBanner"),
  reportDateInput: $("#reportDateInput"),
  reportTimeInput: $("#reportTimeInput"),
  reportTimeHint: $("#reportTimeHint"),
  driverFields: $("#driverFields"),
  vehicleInput: $("#vehicleInput"),
  baseInput: $("#baseInput"),
  attendanceDriverBox: $("#attendanceDriverBox"),
  locationSection: $("#locationSection"),
  locationStatus: $("#locationStatus"),
  locationButton: $("#locationButton"),
  locationMap: $("#locationMap"),
  locationPermissionHelp: $("#locationPermissionHelp"),
  markControls: $("#markControls"),
  sentidoEntradaButton: $("#sentidoEntradaButton"),
  sentidoSalidaButton: $("#sentidoSalidaButton"),
  sentidoSuggestion: $("#sentidoSuggestion"),
  jornadaHint: $("#jornadaHint"),
  stepDni: $("#stepDni"),
  stepPhoto: $("#stepPhoto"),
  stepRegister: $("#stepRegister"),
  stepGuideText: $("#stepGuideText"),
  observacionInput: $("#observacionInput"),
  motivoOverlay: $("#motivoOverlay"),
  motivoTitle: $("#motivoTitle"),
  motivoText: $("#motivoText"),
  motivoOpciones: $("#motivoOpciones"),
  motivoInput: $("#motivoInput"),
  motivoError: $("#motivoError"),
  motivoAccept: $("#motivoAccept"),
  motivoCancel: $("#motivoCancel"),
  cierreOverlay: $("#cierreOverlay"),
  cierreTitle: $("#cierreTitle"),
  cierreText: $("#cierreText"),
  cierreHoraInput: $("#cierreHoraInput"),
  cierreHoraHint: $("#cierreHoraHint"),
  cierreOpciones: $("#cierreOpciones"),
  cierreMotivoInput: $("#cierreMotivoInput"),
  cierreResumen: $("#cierreResumen"),
  cierreError: $("#cierreError"),
  cierreAccept: $("#cierreAccept"),
  cierreCancel: $("#cierreCancel"),
  celularComprobanteInput: $("#celularComprobanteInput"),
  celularAgendaHint: $("#celularAgendaHint"),
  programacionBanner: $("#programacionBanner"),
  puntualidadDesdeInput: $("#puntualidadDesdeInput"),
  puntualidadHastaInput: $("#puntualidadHastaInput"),
  puntualidadTolInput: $("#puntualidadTolInput"),
  puntualidadBuscarButton: $("#puntualidadBuscarButton"),
  puntualidadStatus: $("#puntualidadStatus"),
  puntualidadTotales: $("#puntualidadTotales"),
  puntualidadResumen: $("#puntualidadResumen"),
  puntualidadDetalleBox: $("#puntualidadDetalleBox"),
  puntualidadDetalle: $("#puntualidadDetalle"),
  puntualidadMessage: $("#puntualidadMessage"),
  puenteResolverButton: $("#puenteResolverButton"),
  puenteStatus: $("#puenteStatus"),
  puenteResultado: $("#puenteResultado"),
  jornadasDesdeInput: $("#jornadasDesdeInput"),
  jornadasHastaInput: $("#jornadasHastaInput"),
  jornadasBuscarButton: $("#jornadasBuscarButton"),
  jornadasStatus: $("#jornadasStatus"),
  jornadasFiltros: $("#jornadasFiltros"),
  jornadasTotales: $("#jornadasTotales"),
  jornadasResumen: $("#jornadasResumen"),
  jornadasResumenBox: $("#jornadasResumenBox"),
  jornadasDetalleBox: $("#jornadasDetalleBox"),
  jornadasDetalle: $("#jornadasDetalle"),
  jornadasMessage: $("#jornadasMessage"),
  jornadasExportButton: $("#jornadasExportButton"),
  verificadorDesdeInput: $("#verificadorDesdeInput"),
  verificadorHastaInput: $("#verificadorHastaInput"),
  verificadorBuscarInput: $("#verificadorBuscarInput"),
  verificadorBuscarButton: $("#verificadorBuscarButton"),
  verificadorFiltrarButton: $("#verificadorFiltrarButton"),
  verificadorDiaButton: $("#verificadorDiaButton"),
  verificadorDesfasesButton: $("#verificadorDesfasesButton"),
  verificadorGestoresButton: $("#verificadorGestoresButton"),
  verificadorCierresButton: $("#verificadorCierresButton"),
  verificadorExcedidasButton: $("#verificadorExcedidasButton"),
  verificadorNovedadesButton: $("#verificadorNovedadesButton"),
  verificadorExportButton: $("#verificadorExportButton"),
  verificadorStatus: $("#verificadorStatus"),
  verificadorFiltros: $("#verificadorFiltros"),
  verificadorTotales: $("#verificadorTotales"),
  verificadorDetalle: $("#verificadorDetalle"),
  verificadorMessage: $("#verificadorMessage"),
  horarioDesdeInput: $("#horarioDesdeInput"),
  horarioHastaInput: $("#horarioHastaInput"),
  horarioBuscarInput: $("#horarioBuscarInput"),
  horarioBuscarButton: $("#horarioBuscarButton"),
  horarioExportButton: $("#horarioExportButton"),
  horarioStatus: $("#horarioStatus"),
  horarioResultado: $("#horarioResultado"),
  horarioMessage: $("#horarioMessage"),
  base3DateInput: $("#base3DateInput"),
  base3BuscarButton: $("#base3BuscarButton"),
  base3ExportButton: $("#base3ExportButton"),
  base3Status: $("#base3Status"),
  base3Resultado: $("#base3Resultado"),
  base3Message: $("#base3Message"),
  mapaDesdeInput: $("#mapaDesdeInput"),
  mapaHastaInput: $("#mapaHastaInput"),
  mapaBuscarInput: $("#mapaBuscarInput"),
  mapaBuscarButton: $("#mapaBuscarButton"),
  mapaStatus: $("#mapaStatus"),
  mapaMarcas: $("#mapaMarcas"),
  mapaMessage: $("#mapaMessage"),
  tutorialButton: $("#tutorialButton"),
  tutorialOverlay: $("#tutorialOverlay"),
  tutorialClose: $("#tutorialClose"),
  tutorialIcon: $("#tutorialIcon"),
  tutorialStepNum: $("#tutorialStepNum"),
  tutorialTitle: $("#tutorialTitle"),
  tutorialText: $("#tutorialText"),
  tutorialDots: $("#tutorialDots"),
  tutorialPrev: $("#tutorialPrev"),
  tutorialNext: $("#tutorialNext"),
  adminClaveOverlay: $("#adminClaveOverlay"),
  adminClaveInput: $("#adminClaveInput"),
  adminClaveError: $("#adminClaveError"),
  adminClaveAccept: $("#adminClaveAccept"),
  adminClaveCancel: $("#adminClaveCancel"),
  cameraButton: $("#cameraButton"),
  cameraBox: $("#cameraBox"),
  cameraVideo: $("#cameraVideo"),
  liveFaceStatus: $("#liveFaceStatus"),
  faceGuide: $("#faceGuide"),
  captureButton: $("#captureButton"),
  stopCameraButton: $("#stopCameraButton"),
  previewBox: $("#previewBox"),
  photoPreview: $("#photoPreview"),
  photoName: $("#photoName"),
  photoSize: $("#photoSize"),
  submitButton: $("#submitButton"),
  nextActionNotice: $("#nextActionNotice"),
  formMessage: $("#formMessage"),
  bukResultBox: $("#bukResultBox"),
  processOverlay: $("#processOverlay"),
  processTitle: $("#processTitle"),
  processText: $("#processText"),
  alertOverlay: $("#alertOverlay"),
  alertTitle: $("#alertTitle"),
  alertText: $("#alertText"),
  alertButton: $("#alertButton"),
  photoModalOverlay: $("#photoModalOverlay"),
  photoModalTitle: $("#photoModalTitle"),
  photoModalStatus: $("#photoModalStatus"),
  photoModalImage: $("#photoModalImage"),
  photoModalClose: $("#photoModalClose"),
  registroSuccessOverlay: $("#registroSuccessOverlay"),
  registroSuccessModal: $("#registroSuccessOverlay .registro-success-modal"),
  registroSuccessTitle: $("#registroSuccessTitle"),
  registroSuccessSubtitle: $("#registroSuccessSubtitle"),
  registroSuccessBody: $("#registroSuccessBody"),
  registroSuccessButton: $("#registroSuccessButton"),
  confirmOverlay: $("#confirmOverlay"),
  confirmTitle: $("#confirmTitle"),
  confirmText: $("#confirmText"),
  confirmCancel: $("#confirmCancel"),
  confirmAccept: $("#confirmAccept"),
  openTurnsStatus: $("#openTurnsStatus"),
  openTurnsBody: $("#openTurnsBody"),
  openTurnsReloadButton: $("#openTurnsReloadButton"),
  openTurnsExportButton: $("#openTurnsExportButton"),
  openTurnsSearchInput: $("#openTurnsSearchInput"),
  openTurnsCargoFilter: $("#openTurnsCargoFilter"),
  overdueTurnsStatus: $("#overdueTurnsStatus"),
  overdueTurnsBody: $("#overdueTurnsBody"),
  overdueTurnsExportButton: $("#overdueTurnsExportButton"),
  sentidoRevisionStatus: $("#sentidoRevisionStatus"),
  sentidoRevisionBody: $("#sentidoRevisionBody"),
  refreshButton: $("#refreshButton"),
  historyDniInput: $("#historyDniInput"),
  historyStartDateInput: $("#historyStartDateInput"),
  historyEndDateInput: $("#historyEndDateInput"),
  historySearchButton: $("#historySearchButton"),
  historyPrevPageButton: $("#historyPrevPageButton"),
  historyNextPageButton: $("#historyNextPageButton"),
  historyPageLabel: $("#historyPageLabel"),
  historySubtitle: $("#historySubtitle"),
  historySummary: $("#historySummary"),
  historyTotal: $("#historyTotal"),
  historyLast: $("#historyLast"),
  historyNext: $("#historyNext"),
  historyList: $("#historyList"),
  csvStatus: $("#csvStatus"),
  csvSearchInput: $("#csvSearchInput"),
  reloadCsvButton: $("#reloadCsvButton"),
  csvTableBody: $("#csvTableBody"),
  perfilSocioStatus: $("#perfilSocioStatus"),
  perfilSocioSearchInput: $("#perfilSocioSearchInput"),
  reloadPerfilSocioButton: $("#reloadPerfilSocioButton"),
  perfilSocioBody: $("#perfilSocioBody"),
  perfilSocioMessage: $("#perfilSocioMessage"),
  perfilSocioDetailOverlay: $("#perfilSocioDetailOverlay"),
  perfilSocioDetailBody: $("#perfilSocioDetailBody"),
  perfilSocioDetailClose: $("#perfilSocioDetailClose"),
  manualExitForm: $("#manualExitForm"),
  manualDniInput: $("#manualDniInput"),
  manualDateInput: $("#manualDateInput"),
  manualTimeInput: $("#manualTimeInput"),
  manualReasonCategory: $("#manualReasonCategory"),
  manualReasonInput: $("#manualReasonInput"),
  manualExitButton: $("#manualExitButton"),
  manualMessage: $("#manualMessage"),
  manualCodeButton: $("#manualCodeButton"),
  manualCodeShown: $("#manualCodeShown"),
  manualCodeInput: $("#manualCodeInput"),
  manualLocationButton: $("#manualLocationButton"),
  manualLocationStatus: $("#manualLocationStatus"),
  manualCameraButton: $("#manualCameraButton"),
  manualCameraBox: $("#manualCameraBox"),
  manualCameraVideo: $("#manualCameraVideo"),
  manualCaptureButton: $("#manualCaptureButton"),
  manualCameraCancelButton: $("#manualCameraCancelButton"),
  manualPhotoPreview: $("#manualPhotoPreview"),
  manualPhotoImg: $("#manualPhotoImg"),
  manualPhotoRetakeButton: $("#manualPhotoRetakeButton"),
  sonarAdminForm: $("#sonarAdminForm"),
  sonarDriverSearchInput: $("#sonarDriverSearchInput"),
  loadSonarDriversButton: $("#loadSonarDriversButton"),
  sonarAdminStatus: $("#sonarAdminStatus"),
  sonarDriverSelect: $("#sonarDriverSelect"),
  sonarDriverList: $("#sonarDriverList"),
  sonarDriverSelected: $("#sonarDriverSelected"),
  sonarVehicleSelect: $("#sonarVehicleSelect"),
  sonarSelectionBox: $("#sonarSelectionBox"),
  assignSonarDriverButton: $("#assignSonarDriverButton"),
  sonarAdminMessage: $("#sonarAdminMessage"),
  adminNameSearchInput: $("#adminNameSearchInput"),
  adminDniSearchInput: $("#adminDniSearchInput"),
  adminDateFromInput: $("#adminDateFromInput"),
  adminDateToInput: $("#adminDateToInput"),
  adminCargoFilter: $("#adminCargoFilter"),
  reloadMarksButton: $("#reloadMarksButton"),
  adminMarksStatus: $("#adminMarksStatus"),
  adminMarksBody: $("#adminMarksBody"),
  adminPrevPageButton: $("#adminPrevPageButton"),
  adminNextPageButton: $("#adminNextPageButton"),
  adminPageLabel: $("#adminPageLabel"),
  enrollFaceForm: $("#enrollFaceForm"),
  enrollDniInput: $("#enrollDniInput"),
  enrollValidateButton: $("#enrollValidateButton"),
  enrollBox: $("#enrollBox"),
  enrollPreviewBox: $("#enrollPreviewBox"),
  enrollPreviewImage: $("#enrollPreviewImage"),
  enrollCameraButton: $("#enrollCameraButton"),
  deleteEnrollButton: $("#deleteEnrollButton"),
  enrollMessage: $("#enrollMessage"),
  journalStatus: $("#journalStatus"),
  journalDateFromInput: $("#journalDateFromInput"),
  journalDateToInput: $("#journalDateToInput"),
  journalSearchInput: $("#journalSearchInput"),
  journalCargoFilter: $("#journalCargoFilter"),
  reloadJournalButton: $("#reloadJournalButton"),
  exportJournalButton: $("#exportJournalButton"),
  journalBody: $("#journalBody"),
  journalPrevPageButton: $("#journalPrevPageButton"),
  journalPageLabel: $("#journalPageLabel"),
  journalNextPageButton: $("#journalNextPageButton"),
  rechazoStatus: $("#rechazoStatus"),
  rechazoDateFromInput: $("#rechazoDateFromInput"),
  rechazoDateToInput: $("#rechazoDateToInput"),
  rechazoSearchInput: $("#rechazoSearchInput"),
  reloadRechazoButton: $("#reloadRechazoButton"),
  exportRechazoButton: $("#exportRechazoButton"),
  resendAllRechazoButton: $("#resendAllRechazoButton"),
  rechazoBody: $("#rechazoBody"),
  rechazoPrevPageButton: $("#rechazoPrevPageButton"),
  rechazoPageLabel: $("#rechazoPageLabel"),
  rechazoNextPageButton: $("#rechazoNextPageButton"),
  inconsistStatus: $("#inconsistStatus"),
  inconsistDateFromInput: $("#inconsistDateFromInput"),
  inconsistDateToInput: $("#inconsistDateToInput"),
  inconsistSearchInput: $("#inconsistSearchInput"),
  reloadInconsistButton: $("#reloadInconsistButton"),
  exportInconsistButton: $("#exportInconsistButton"),
  inconsistBody: $("#inconsistBody"),
  inconsistMessage: $("#inconsistMessage"),
  sinMarcaStatus: $("#sinMarcaStatus"),
  sinMarcaDaysInput: $("#sinMarcaDaysInput"),
  sinMarcaMaxBioInput: $("#sinMarcaMaxBioInput"),
  sinMarcaSearchInput: $("#sinMarcaSearchInput"),
  reloadSinMarcaButton: $("#reloadSinMarcaButton"),
  exportSinMarcaButton: $("#exportSinMarcaButton"),
  sinMarcaBody: $("#sinMarcaBody"),
  sinMarcaMessage: $("#sinMarcaMessage"),
  corregirDniInput: $("#corregirDniInput"),
  corregirDateInput: $("#corregirDateInput"),
  corregirBuscarButton: $("#corregirBuscarButton"),
  corregirStatus: $("#corregirStatus"),
  corregirResultado: $("#corregirResultado"),
  corregirMessage: $("#corregirMessage"),
  validacionStatus: $("#validacionStatus"),
  validacionDateFromInput: $("#validacionDateFromInput"),
  validacionDateToInput: $("#validacionDateToInput"),
  validacionMaxHorasInput: $("#validacionMaxHorasInput"),
  validacionSearchInput: $("#validacionSearchInput"),
  validacionFiltroTipo: $("#validacionFiltroTipo"),
  reloadValidacionButton: $("#reloadValidacionButton"),
  exportValidacionButton: $("#exportValidacionButton"),
  validacionResumen: $("#validacionResumen"),
  validacionBody: $("#validacionBody"),
  validacionMessage: $("#validacionMessage")
};

function setMessage(target, text, type = "") {
  target.textContent = text;
  target.className = `message ${type}`.trim();
}

function setBusy(button, busy) {
  button.disabled = busy;
}

function showProcess(title, text) {
  if (!elements.processOverlay) return;
  elements.processTitle.textContent = title;
  elements.processText.textContent = text;
  elements.processOverlay.classList.remove("hidden");
}

function hideProcess() {
  elements.processOverlay?.classList.add("hidden");
}

function showAlertModal(title, text) {
  elements.alertTitle.textContent = title;
  elements.alertText.textContent = text;
  elements.alertOverlay.classList.remove("hidden");
}

function hideAlertModal() {
  elements.alertOverlay.classList.add("hidden");
}

// Muestra la foto de evidencia de una marca (entrada o salida) en un modal.
// La foto vive en un bucket privado, asi que se pide una URL firmada cada vez
// -no se puede simplemente apuntar <img> al path guardado en la base.
async function showPhotoModal(fotoPath, label) {
  if (!elements.photoModalOverlay) return;
  // Cerrojo de secuencia: si el admin hace click en "Ver foto" de otra fila antes
  // de que esta respuesta llegue, la createSignedUrl de la primera podria resolver
  // DESPUES de la segunda y pisar la imagen/estado correctos con la foto equivocada.
  const seq = ++state.photoModalRequestSeq;
  elements.photoModalTitle.textContent = label || "Foto de la marca";
  elements.photoModalStatus.textContent = "Cargando foto...";
  elements.photoModalStatus.classList.remove("hidden");
  elements.photoModalImage.classList.add("hidden");
  elements.photoModalImage.removeAttribute("src");
  elements.photoModalOverlay.classList.remove("hidden");

  if (!fotoPath) {
    if (seq === state.photoModalRequestSeq) {
      elements.photoModalStatus.textContent = "Esta marca no tiene foto guardada.";
    }
    return;
  }

  const { data, error } = await supabaseClient.storage
    .from(config.FOTO_BUCKET)
    .createSignedUrl(fotoPath, 300);

  if (seq !== state.photoModalRequestSeq) return; // se abrio otra foto mientras tanto

  if (error || !data?.signedUrl) {
    // La purga automatica borra las fotos pasados unos dias (15 normales / 25
    // selfies): si ya no existe, este mensaje es lo esperado, no un error real.
    elements.photoModalStatus.textContent =
      "No se pudo cargar la foto: puede que ya se haya purgado del almacenamiento.";
    return;
  }

  elements.photoModalImage.src = data.signedUrl;
  elements.photoModalImage.classList.remove("hidden");
  elements.photoModalStatus.classList.add("hidden");
}

function hidePhotoModal() {
  elements.photoModalOverlay?.classList.add("hidden");
  elements.photoModalImage?.removeAttribute("src");
}

function showRegistroModal({ titulo, subtitulo = "", ok = true, filas = [] }) {
  if (!elements.registroSuccessOverlay) return;
  elements.registroSuccessTitle.textContent = titulo;
  elements.registroSuccessSubtitle.textContent = subtitulo;
  elements.registroSuccessSubtitle.classList.toggle("hidden", !subtitulo);
  elements.registroSuccessModal?.classList.toggle("is-pending", !ok);
  elements.registroSuccessBody.innerHTML = filas
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
    .map(([label, value, esError]) => `
      <div class="registro-success-row ${esError ? "is-error" : ""}">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(String(value))}</strong>
      </div>
    `).join("");
  elements.registroSuccessOverlay.classList.remove("hidden");
  renderIcons();
}

function hideRegistroModal() {
  elements.registroSuccessOverlay?.classList.add("hidden");
}

function isMobilePhotoOnlyMode() {
  return state.cameraMode === "attendance"
    && !requiresBiometric()
    && (document.documentElement.classList.contains("touch-device") || window.matchMedia?.("(max-width: 820px)").matches);
}

function isEvidenceOnlyMode() {
  return state.cameraMode === "attendance";
}

function setNextActionNotice(text = "") {
  if (!elements.nextActionNotice) return;
  elements.nextActionNotice.textContent = text;
  elements.nextActionNotice.classList.toggle("hidden", !text);
}

function clearBukResult() {
  elements.bukResultBox.textContent = "";
  elements.bukResultBox.classList.add("hidden");
}

function showBukResult(value) {
  elements.bukResultBox.textContent = JSON.stringify(value, null, 2);
  elements.bukResultBox.classList.remove("hidden");
}

const STEP_GUIDE_TEXT = {
  dni: "Escribe tu numero de cedula y presiona Validar.",
  photo: "Verifica que ese sea tu nombre y mira a la camara para tomar tu foto.",
  register: "Revisa tus datos y presiona Registrar asistencia para terminar.",
};

function setWorkflowState(stage) {
  state.workflowStage = stage;
  [elements.stepDni, elements.stepPhoto, elements.stepRegister].forEach((step) => {
    step.classList.remove("active", "done");
  });

  if (elements.stepGuideText) {
    elements.stepGuideText.textContent = STEP_GUIDE_TEXT[stage] || "";
  }

  if (stage === "dni") {
    elements.stepDni.classList.add("active");
  }

  if (stage === "photo") {
    elements.stepDni.classList.add("done");
    elements.stepPhoto.classList.add("active");
  }

  if (stage === "register") {
    elements.stepDni.classList.add("done");
    elements.stepPhoto.classList.add("done");
    elements.stepRegister.classList.add("active");
    setTimeout(() => {
      if (!elements.submitButton) return;
      elements.submitButton.scrollIntoView({ behavior: "smooth", block: "center" });
      try { elements.submitButton.focus({ preventScroll: true }); } catch (_) {}
    }, 220);
    if (!state.currentLocation) {
      setTimeout(() => { captureCurrentLocation(); }, 350);
    }
  }

  const faltaUbicacion = stage === "register" && !state.currentLocation;
  elements.cameraButton.disabled = stage === "dni";
  elements.submitButton.disabled = stage !== "register" || faltaUbicacion;
  elements.submitButton.classList.toggle("attention", stage === "register" && !faltaUbicacion);
  elements.markControls.classList.toggle("hidden", stage === "dni");
  renderSentidoSelector();
  renderJornadaHint();

  if (stage === "dni") {
    setNextActionNotice("");
  } else if (stage === "photo") {
    setNextActionNotice("Paso pendiente: abre la camara y toma una foto del colaborador.");
  } else if (stage === "register") {
    setNextActionNotice(faltaUbicacion
      ? "Falta la UBICACIÓN para registrar. Toca 'Activar ubicación' y permite el acceso."
      : "Ultimo paso: toca el boton verde Registrar asistencia para guardar la marca.");
  }
}

// Habilita/deshabilita el boton Registrar segun haya ubicacion (obligatoria).
function syncSubmitLockPorUbicacion() {
  if (state.workflowStage !== "register" || !elements.submitButton) return;
  const faltaUbicacion = !state.currentLocation;
  elements.submitButton.disabled = faltaUbicacion;
  elements.submitButton.classList.toggle("attention", !faltaUbicacion);
  setNextActionNotice(faltaUbicacion
    ? "Falta la UBICACIÓN para registrar. Toca 'Activar ubicación' y permite el acceso."
    : "Ultimo paso: toca el boton verde Registrar asistencia para guardar la marca.");
}

async function rollbackAttendanceFailure({ asistenciaId, photoPath, dni, bukData }) {
  showProcess("Reintentando envio", "Buk rechazo la marca. Limpiando para reintentar...");

  const rollbackErrors = [];

  if (asistenciaId) {
    const { error } = await supabaseClient
      .from("asistencias")
      .delete()
      .eq("id", asistenciaId);
    if (error) rollbackErrors.push(`marca: ${error.message}`);
  }

  if (photoPath) {
    const { error } = await supabaseClient.storage
      .from(config.FOTO_BUCKET)
      .remove([photoPath]);
    if (error) rollbackErrors.push(`foto: ${error.message}`);
  }

  setNextActionNotice("Buk fallo. Toca de nuevo el boton verde Registrar asistencia para reintentar.");

  const bukErrorText = bukData?.error || bukData?.respuesta?.error || "Buk/Ctrlit rechazo la marca.";
  setMessage(elements.formMessage, `Buk rechazo la marca. Toca de nuevo Registrar asistencia para reintentar. Detalle: ${bukErrorText}`, "error");

  if (rollbackErrors.length) {
    const modalText = `Buk rechazo la marca. Se intento revertir la asistencia con estos problemas: ${rollbackErrors.join(", ")}. Toca de nuevo Registrar asistencia para reintentar.`;
    showAlertModal("Reintentar registro", modalText);
  }

  elements.dniInput.value = dni || elements.dniInput.value;
  throw new Error("Buk rechazo la marca. Toca Registrar para reintentar.");
}

function resetCaptureState(clearHistory = true) {
  state.colaborador = null;
  state.csvCandidate = null;
  state.compressedFile = null;
  state.faceValidated = false;
  state.faceWarning = "";
  state.currentLocation = null;
  state.isDriverCandidate = false;
  state.attendanceSonarDriver = null;
  state.openEntrada = null;
  configureDriverFields(null);
  elements.previewBox.classList.add("hidden");
  elements.photoPreview.removeAttribute("src");
  elements.locationSection?.classList.add("hidden");
  if (elements.locationStatus) elements.locationStatus.textContent = "Pendiente por validar coordenadas.";
  setNextActionNotice("");
  setWorkflowState("dni");
  hideDriverGreetingCard();
  renderTurnoStatusBanner();
  clearBukResult();
  if (clearHistory) clearHistoryPanel();
}

function renderIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function isOnline() {
  return navigator.onLine;
}

function updateConnectionStatus() {
  const online = isOnline();
  elements.connectionStatus.textContent = online ? "Con conexión" : "Sin conexión";
  elements.connectionStatus.classList.toggle("online", online);
  elements.connectionStatus.classList.toggle("offline", !online);

  if (!online) {
    if (elements.searchButton) elements.searchButton.disabled = true;
    if (elements.cameraButton) elements.cameraButton.disabled = true;
    if (elements.submitButton) elements.submitButton.disabled = true;
    if (elements.manualExitButton) elements.manualExitButton.disabled = true;
    setMessage(elements.formMessage, "Sin internet. No se puede validar ni registrar asistencia.", "error");
  } else {
    if (elements.searchButton) elements.searchButton.disabled = false;
    if (elements.manualExitButton) elements.manualExitButton.disabled = false;
    setWorkflowState(state.faceValidated
      ? "register"
      : (state.csvCandidate && state.identidadConfirmada ? "photo" : "dni"));
  }
}

function requireOnline(messageTarget = elements.formMessage) {
  if (isOnline()) return true;
  updateConnectionStatus();
  setMessage(messageTarget, "Sin internet. Revisa la conexión antes de continuar.", "error");
  return false;
}

async function syncServerClock({ silent = false } = {}) {
  if (!requireOnline()) return null;

  const { data, error } = await supabaseClient.rpc("obtener_hora_servidor_colombia");
  if (error || !data) {
    if (!silent) {
      setMessage(elements.formMessage, "No se pudo sincronizar la hora del servidor.", "error");
    }
    return null;
  }

  state.serverClock = {
    syncedAtMs: Date.now(),
    timestamp: data.timestamp,
    fecha: data.fecha,
    hora: data.hora
  };
  renderServerClock();
  return state.serverClock;
}

function getTrustedNowParts() {
  if (!state.serverClock) return getTodayPartsFromDate(new Date());

  const base = new Date(`${state.serverClock.timestamp}-05:00`);
  const trusted = new Date(base.getTime() + (Date.now() - state.serverClock.syncedAtMs));
  return getTodayPartsFromDate(trusted);
}

// Solo en entorno LOCAL (localhost / archivo) se permite editar la fecha/hora del
// registro, para pruebas. En produccion la hora siempre viene del servidor.
function isLocalEnv() {
  return ["localhost", "127.0.0.1", "0.0.0.0", ""].includes(location.hostname);
}

function renderServerClock() {
  const now = getTrustedNowParts();
  // En local, si el usuario ya edito manualmente el campo, no lo pisamos con el reloj.
  if (!(isLocalEnv() && state.reportDateTouched)) elements.reportDateInput.value = now.date;
  if (!(isLocalEnv() && state.reportTimeTouched)) elements.reportTimeInput.value = now.time.slice(0, 5);
}

function configureReportTimeControls() {
  const local = isLocalEnv();
  elements.reportDateInput.disabled = !local ? true : false;
  elements.reportTimeInput.disabled = !local ? true : false;
  elements.reportDateInput.readOnly = !local;
  elements.reportTimeInput.readOnly = !local;
  elements.reportTimeHint.textContent = local
    ? "MODO LOCAL: puedes modificar la fecha y hora para pruebas. En producción vienen del servidor."
    : "La fecha y hora vienen del servidor y no se pueden modificar.";
}

function getReportParts() {
  // En local, si el usuario edito la fecha/hora, usamos esos valores (para pruebas).
  if (isLocalEnv() && (state.reportDateTouched || state.reportTimeTouched)
      && elements.reportDateInput.value && elements.reportTimeInput.value) {
    const date = elements.reportDateInput.value;
    const t = elements.reportTimeInput.value;
    const time = t.length === 5 ? `${t}:00` : t;
    const [year, month, day] = date.split("-");
    return { year, month, day, date, time };
  }
  const now = getTrustedNowParts();
  const date = now.date;
  const time = now.time;
  const [year, month, day] = date.split("-");
  return { year, month, day, date, time };
}

const SERVER_CLOCK_RESYNC_MS = 3 * 60 * 1000;

function startServerClock() {
  window.clearInterval(state.serverClockTimer);
  window.clearInterval(state.serverClockResyncTimer);
  syncServerClock();
  state.serverClockTimer = window.setInterval(() => {
    if (state.serverClock) renderServerClock();
  }, 1000);
  state.serverClockResyncTimer = window.setInterval(() => {
    syncServerClock({ silent: true });
  }, SERVER_CLOCK_RESYNC_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.user) {
    syncServerClock({ silent: true });
  }
});
window.addEventListener("online", () => {
  if (state.user) {
    syncServerClock({ silent: true });
  }
});

async function init() {
  renderIcons();
  updateConnectionStatus();
  window.addEventListener("online", updateConnectionStatus);
  window.addEventListener("offline", updateConnectionStatus);

  if (!hasConfig) {
    setMessage(elements.loginMessage, "Falta configurar Supabase en supabase-config.js.", "error");
    elements.loginForm.querySelectorAll("input, button").forEach((el) => {
      el.disabled = true;
    });
    return;
  }

  setWorkflowState("dni");

  const { data } = await supabaseClient.auth.getSession();
  if (data.session?.user) {
    showApp(data.session.user);
  } else {
    showLogin();
  }

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    const nuevoUserId = session?.user?.id || null;
    const actualUserId = state.user?.id || null;

    if (!nuevoUserId) {
      // Cierre de sesion.
      if (actualUserId) showLogin();
      return;
    }

    // Solo (re)inicializa la app si es un usuario DISTINTO al ya cargado.
    // Evita que TOKEN_REFRESHED / SIGNED_IN repetidos (refresco de token, al
    // enfocar la pestana) reinicien la app y borren lo que se esta viendo.
    if (nuevoUserId !== actualUserId) {
      showApp(session.user);
    }
  });

  setupEmbeddedAutoLogin();
}

// Auto-login cuando la app va embebida en un iframe (ej. portal de enturnamiento).
// El padre envia { type: "BIOMETRICO_SESSION", payload: { access_token, refresh_token }}
// por postMessage; aqui aplicamos esa sesion con setSession (funciona aunque el
// almacenamiento este bloqueado). Al terminar, avisamos al padre con OK/FAIL, y al
// arrancar le mandamos BIOMETRICO_READY para que nos reenvie la sesion.
function setupEmbeddedAutoLogin() {
  if (window.parent === window) return; // no estamos embebidos

  window.addEventListener("message", async (event) => {
    const data = event.data;
    if (!data || typeof data !== "object" || data.type !== "BIOMETRICO_SESSION") return;
    const p = data.payload || {};
    if (!p.access_token || !p.refresh_token) return;
    try {
      const { error } = await supabaseClient.auth.setSession({
        access_token: p.access_token,
        refresh_token: p.refresh_token
      });
      if (error) throw error;
      event.source?.postMessage({ type: "BIOMETRICO_SESSION_OK", email: p.user_email || "" }, event.origin);
    } catch (e) {
      event.source?.postMessage({ type: "BIOMETRICO_SESSION_FAIL", error: e?.message || String(e) }, event.origin);
    }
  });

  // Avisar al padre que ya estamos listos para recibir la sesion.
  try { window.parent.postMessage({ type: "BIOMETRICO_READY" }, "*"); } catch (_) {}
}

function showLogin() {
  state.user = null;
  stopCamera();
  elements.loginView.classList.remove("hidden");
  elements.appView.classList.add("hidden");
  clearHistoryPanel();
}

function getDisplayNameForUser(user) {
  if (!user) return "Usuario autenticado";
  const meta = user.user_metadata || {};
  return meta.display_name || meta.full_name || meta.name || user.email || "Usuario autenticado";
}

async function showApp(user) {
  state.user = user;
  elements.userLabel.textContent = getDisplayNameForUser(user);
  elements.loginView.classList.add("hidden");
  elements.appView.classList.remove("hidden");
  await loadProfile();
  setupManualDefaults();
  startServerClock();
  loadCollaboratorsCsv();
  clearHistoryPanel();
}

async function login(event) {
  event.preventDefault();
  setBusy(elements.loginForm.querySelector("button"), true);
  setMessage(elements.loginMessage, "");

  const email = elements.emailInput.value.trim();
  const password = elements.passwordInput.value;
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });

  if (error) {
    setMessage(elements.loginMessage, "Usuario o contrasena incorrectos.", "error");
  }

  setBusy(elements.loginForm.querySelector("button"), false);
}

async function logout() {
  state.adminUnlocked = false;
  try { sessionStorage.removeItem("admin_unlocked"); } catch (_) {}
  await supabaseClient.auth.signOut();
}

// Las pestañas de administrador (Administración, Base colaboradores, Salida
// incapacidad) NO se muestran en modo movil, aunque el usuario sea admin.
// El movil es solo para registrar rapido.
function applyTabVisibility() {
  if (!elements.adminTabButton) return;
  const esMovil = state.deviceMode === "mobile";
  const mostrarAdmin = state.isAdmin && !esMovil;

  elements.adminTabButton.classList.toggle("hidden", !mostrarAdmin);
  elements.manualExitTabButton?.classList.toggle("hidden", !mostrarAdmin);

  // Si el usuario esta en una pestaña de admin que ya no debe verse, volver a Registro.
  // (La Base de colaboradores ahora vive dentro del panel de Administración.)
  if (!mostrarAdmin && state.user) {
    const enPanelAdmin =
      !elements.adminPanel.classList.contains("hidden") ||
      (elements.manualExitPanel && !elements.manualExitPanel.classList.contains("hidden"));
    if (enPanelAdmin) showTab("register");
  }
}

async function loadProfile() {
  const { data } = await supabaseClient
    .from("perfiles")
    .select("rol,activo")
    .eq("user_id", state.user.id)
    .maybeSingle();

  state.isAdmin = Boolean(data?.activo && data?.rol === "admin");
  applyTabVisibility();
  configureReportTimeControls();

  if (state.isAdmin) {
    loadOpenTurns().catch(() => {});
    loadSentidoRevisionMarks().catch(() => {});
  } else {
    state.overdueDriversCount = 0;
    state.sentidoRevisionCount = 0;
    updateAlertsBadge(0);
  }
}

// El badge de la pestaña Alertas suma turnos vencidos + marcas con sentido a
// revisar: son las dos cosas de esa pestaña que necesitan que un admin actue.
function refreshAlertsBadge() {
  updateAlertsBadge(state.overdueDriversCount + state.sentidoRevisionCount);
}

function updateAlertsBadge(count) {
  const label = !count || count <= 0 ? "" : (count > 99 ? "99+" : String(count));
  [elements.adminTabBadge, elements.adminSubtabAlertsBadge].forEach((badge) => {
    if (!badge) return;
    if (!label) {
      badge.classList.add("hidden");
      badge.textContent = "0";
    } else {
      badge.textContent = label;
      badge.classList.remove("hidden");
    }
  });
}

// ---- Corregir horas de ingreso/salida (subpestaña admin) ----
async function buscarCorregir() {
  const dni = normalizeDni(elements.corregirDniInput.value);
  const fecha = (elements.corregirDateInput.value || "").trim();
  setMessage(elements.corregirMessage, "");
  if (!dni || !fecha) {
    setMessage(elements.corregirMessage, "Digita la cédula y la fecha.", "error");
    return;
  }
  if (!requireOnline(elements.corregirStatus)) return;

  elements.corregirStatus.textContent = "Buscando marcas...";
  elements.corregirResultado.innerHTML = "";

  const { data: colab, error: eColab } = await supabaseClient
    .from("colaboradores").select("id,nombre").eq("dni", dni).maybeSingle();
  if (eColab || !colab) {
    elements.corregirStatus.textContent = "No se encontró un colaborador con esa cédula.";
    return;
  }

  const { data, error } = await supabaseClient
    .from("asistencias")
    .select("id,fecha,hora,sentido,origen,enviado_buk,vehiculo_reporte")
    .eq("colaborador_id", colab.id)
    .eq("fecha", fecha)
    .order("hora", { ascending: true });

  if (error) {
    elements.corregirStatus.textContent = "No se pudieron cargar las marcas.";
    setMessage(elements.corregirMessage, error.message || "Error consultando.", "error");
    return;
  }
  state.corregirRows = data || [];
  state.corregirNombre = colab.nombre || "";
  renderCorregir();
}

function renderCorregir() {
  const rows = state.corregirRows || [];
  if (!rows.length) {
    elements.corregirStatus.textContent = `Sin marcas para ${state.corregirNombre || "ese conductor"} en esa fecha.`;
    elements.corregirResultado.innerHTML = "";
    return;
  }
  elements.corregirStatus.textContent = `${rows.length} marca(s) — ${state.corregirNombre}`;
  elements.corregirResultado.innerHTML = rows.map((m) => {
    const id = escapeHtml(String(m.id));
    const buk = m.enviado_buk ? "Buk OK" : "pendiente Buk";
    return `
    <div class="corregir-row" data-id="${id}">
      <div class="corregir-campos">
        <label>Tipo
          <select class="corregir-sentido">
            <option value="entrada"${m.sentido === "entrada" ? " selected" : ""}>Entrada</option>
            <option value="salida"${m.sentido === "salida" ? " selected" : ""}>Salida</option>
          </select>
        </label>
        <label>Fecha
          <input type="date" class="corregir-fecha" value="${escapeHtml(m.fecha)}">
        </label>
        <label>Hora
          <input type="time" class="corregir-hora" value="${escapeHtml(String(m.hora).slice(0, 5))}" step="60">
        </label>
        <label>Vehículo
          <input type="text" class="corregir-vehiculo" value="${escapeHtml(m.vehiculo_reporte || "")}" placeholder="Opcional">
        </label>
      </div>
      <div class="corregir-acciones">
        <span class="corregir-origen">${escapeHtml(m.origen || "")} · ${buk}</span>
        <button type="button" class="mini-button corregir-guardar" data-id="${id}">Guardar</button>
        <button type="button" class="mini-button danger corregir-borrar" data-id="${id}">Borrar</button>
      </div>
    </div>`;
  }).join("");
  renderIcons();
}

async function guardarCorreccionMarca(id) {
  const rowEl = elements.corregirResultado.querySelector(`.corregir-row[data-id="${id}"]`);
  if (!rowEl) return;
  const sentido = rowEl.querySelector(".corregir-sentido").value;
  const fecha = rowEl.querySelector(".corregir-fecha").value;
  const hora = rowEl.querySelector(".corregir-hora").value;
  const vehiculo = rowEl.querySelector(".corregir-vehiculo").value.trim();
  if (!fecha || !hora) {
    setMessage(elements.corregirMessage, "Fecha y hora son obligatorias.", "error");
    return;
  }
  const horaFull = hora.length === 5 ? `${hora}:00` : hora;

  const ok = await confirmGraphical(
    "Guardar cambios",
    `¿Guardar esta marca como ${sentido.toUpperCase()} el ${fecha} a las ${hora}? Se cambia solo en la base local (no en Buk).`,
    "Sí, guardar", "Cancelar"
  );
  if (!ok) return;

  const { data, error } = await supabaseClient.rpc("actualizar_marca_asistencia", {
    p_id: id, p_fecha: fecha, p_hora: horaFull, p_sentido: sentido, p_vehiculo: vehiculo || null
  });
  if (error || !data?.ok) {
    setMessage(elements.corregirMessage, `No se pudo guardar: ${error?.message || data?.error || "error"}`, "error");
    return;
  }
  const row = (state.corregirRows || []).find((r) => r.id === id);
  if (row) { row.fecha = fecha; row.hora = horaFull; row.sentido = sentido; row.vehiculo_reporte = vehiculo || null; }
  setMessage(elements.corregirMessage, `✅ Marca actualizada (${sentido} ${fecha} ${hora}).`, "success");
}

async function borrarMarcaCorregir(id) {
  const row = (state.corregirRows || []).find((r) => r.id === id);
  const avisoBuk = row?.enviado_buk
    ? " OJO: esta marca YA está en Buk; borrarla aquí NO la quita de Buk/nómina."
    : "";
  const ok = await confirmGraphical(
    "Borrar marca",
    `¿Seguro que quieres ELIMINAR esta marca? Esta acción no se puede deshacer.${avisoBuk}`,
    "Sí, borrar", "Cancelar"
  );
  if (!ok) return;

  const { data, error } = await supabaseClient.rpc("eliminar_asistencia", { p_id: id });
  if (error || !data?.ok) {
    setMessage(elements.corregirMessage, `No se pudo borrar: ${error?.message || data?.error || "error"}`, "error");
    return;
  }
  state.corregirRows = (state.corregirRows || []).filter((r) => r.id !== id);
  renderCorregir();
  setMessage(elements.corregirMessage, "🗑 Marca eliminada.", "success");
}

/* ==========================================================================
   Administracion > Puntualidad
   ========================================================================== */

function setupPuntualidadDefaults() {
  if (!elements.puntualidadDesdeInput || elements.puntualidadDesdeInput.value) return;
  const hoy = getTodayParts().date;
  const desde = new Date(`${hoy}T00:00:00`);
  desde.setDate(desde.getDate() - 29);
  elements.puntualidadDesdeInput.value = desde.toISOString().slice(0, 10);
  elements.puntualidadHastaInput.value = hoy;
}

async function cargarPuntualidad() {
  const desde = elements.puntualidadDesdeInput?.value;
  const hasta = elements.puntualidadHastaInput?.value;
  const tolerancia = Number(elements.puntualidadTolInput?.value || PUNTUALIDAD_TOLERANCIA_MIN);

  if (!desde || !hasta) {
    setMessage(elements.puntualidadMessage, "Selecciona el rango de fechas.", "error");
    return;
  }
  if (desde > hasta) {
    setMessage(elements.puntualidadMessage, "La fecha inicial no puede ser mayor que la final.", "error");
    return;
  }

  setBusy(elements.puntualidadBuscarButton, true);
  setMessage(elements.puntualidadMessage, "");
  elements.puntualidadStatus.textContent = "Consultando...";

  try {
    const { data, error } = await supabaseClient.rpc("reporte_puntualidad", {
      p_desde: desde, p_hasta: hasta, p_tolerancia: tolerancia
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || "No se pudo generar el reporte.");

    state.puntualidadLoaded = true;
    renderPuntualidad(data);
  } catch (e) {
    elements.puntualidadStatus.textContent = "No se pudo consultar la puntualidad.";
    setMessage(elements.puntualidadMessage, e?.message || "Error consultando puntualidad.", "error");
  } finally {
    setBusy(elements.puntualidadBuscarButton, false);
  }
}

function renderPuntualidad(data) {
  const t = data.totales || {};
  const resumen = data.resumen || [];
  const detalle = data.detalle || [];

  elements.puntualidadStatus.textContent =
    `${data.desde} a ${data.hasta} · tolerancia ${data.tolerancia} min`;

  elements.puntualidadTotales.innerHTML = `
    <div class="punt-card"><span>${t.conductores ?? 0}</span><small>conductores</small></div>
    <div class="punt-card"><span>${t.evaluadas ?? 0}</span><small>marcas evaluadas</small></div>
    <div class="punt-card falta"><span>${t.faltas ?? 0}</span><small>faltas</small></div>
    <div class="punt-card muted"><span>${t.no_evaluables ?? 0}</span><small>no evaluables</small></div>
  `;

  if (!resumen.length) {
    elements.puntualidadResumen.innerHTML =
      `<p class="field-hint">Sin faltas en este rango con tolerancia de ${data.tolerancia} minutos.</p>`;
    elements.puntualidadDetalleBox.classList.add("hidden");
    return;
  }

  elements.puntualidadResumen.innerHTML = `
    <table class="punt-tabla">
      <thead><tr>
        <th>Conductor</th><th>Cédula</th><th>Faltas</th>
        <th>Entrada tarde</th><th>Salida temprana</th><th>Min. acumulados</th><th>Peor</th>
      </tr></thead>
      <tbody>
        ${resumen.map((r) => `
          <tr>
            <td>${escapeHtml(r.nombre || "")}</td>
            <td>${escapeHtml(r.dni || "")}</td>
            <td><strong>${r.faltas}</strong></td>
            <td>${r.entrada_tarde}</td>
            <td>${r.salida_temprana}</td>
            <td>${r.minutos_total}</td>
            <td>${r.peor} min</td>
          </tr>`).join("")}
      </tbody>
    </table>
  `;

  elements.puntualidadDetalleBox.classList.remove("hidden");
  elements.puntualidadDetalle.innerHTML = `
    <table class="punt-tabla">
      <thead><tr>
        <th>Fecha</th><th>Conductor</th><th>Tipo</th><th>Turno</th>
        <th>Programado</th><th>Marcó</th><th>Diferencia</th><th>Vehículo</th>
      </tr></thead>
      <tbody>
        ${detalle.map((d) => `
          <tr>
            <td>${escapeHtml(d.fecha || "")}</td>
            <td>${escapeHtml(d.nombre || "")}</td>
            <td>${d.tipo === "salida_temprana" ? "Salió antes" : "Llegó tarde"}</td>
            <td>${d.turno ?? ""}</td>
            <td>${escapeHtml(d.hora_programada || "")}</td>
            <td>${escapeHtml(d.hora || "")}</td>
            <td><strong>${d.minutos} min</strong></td>
            <td>${escapeHtml(d.vehiculo || "")}${
              d.vehiculo_programado && !String(d.vehiculo || "").includes(d.vehiculo_programado)
                ? ` <span class="punt-warn">(prog. ${escapeHtml(d.vehiculo_programado)})</span>` : ""}</td>
          </tr>`).join("")}
      </tbody>
    </table>
  `;
}

// Estado del cruce nombre de la programacion -> cedula.
async function cargarEstadoPuente() {
  if (!elements.puenteResultado) return;
  try {
    const { data, error } = await supabaseClient
      .from("programacion_conductor_dni")
      .select("nombre_programacion,nombre_colaborador,dni,metodo,similitud")
      .order("metodo");
    if (error) throw error;

    const total = data.length;
    const sinCruce = data.filter((r) => !r.dni && r.metodo !== "ignorado");
    const parecidos = data.filter((r) => r.metodo === "parecido");

    elements.puenteStatus.textContent =
      `${total - sinCruce.length} de ${total} nombres resueltos.`;

    if (!sinCruce.length && !parecidos.length) {
      elements.puenteResultado.innerHTML =
        `<p class="field-hint">Todos los nombres de la programación están cruzados con una cédula.</p>`;
      return;
    }

    elements.puenteResultado.innerHTML = `
      ${sinCruce.length ? `
        <p class="punt-warn"><strong>${sinCruce.length} sin cruce</strong> — sus marcas no se comparan
        contra la programación:</p>
        <ul class="punt-lista">${sinCruce.map((r) =>
          `<li>${escapeHtml(r.nombre_programacion)}</li>`).join("")}</ul>` : ""}
      ${parecidos.length ? `
        <p class="punt-warn"><strong>${parecidos.length} cruzados por parecido</strong> — verifica que
        estén bien:</p>
        <ul class="punt-lista">${parecidos.map((r) =>
          `<li>${escapeHtml(r.nombre_programacion)} → ${escapeHtml(r.nombre_colaborador || "")}
           (${escapeHtml(r.dni || "")}) · ${Math.round((r.similitud || 0) * 100)}%</li>`).join("")}</ul>` : ""}
    `;
  } catch (e) {
    elements.puenteStatus.textContent = "No se pudo consultar el cruce de nombres.";
  }
}

// Vuelve a intentar el cruce usando el CSV de colaboradores (la fuente real).
async function resolverNombresProgramacion() {
  setBusy(elements.puenteResolverButton, true);
  try {
    await ensureCsvLoaded();
    const personas = state.csvRows
      .map((r) => ({ dni: normalizeDni(r.cedula), nombre: r.nombre }))
      .filter((p) => p.dni && p.nombre);

    const { data, error } = await supabaseClient.rpc("sincronizar_nombres_programacion", {
      p_personas: personas
    });
    if (error) throw error;

    setMessage(elements.puntualidadMessage,
      `Nombres resueltos: ${data.exacto} exactos, ${data.orden} por orden, ${data.parecido} por parecido. `
      + `Quedan ${data.sin_resolver} sin resolver.`, "success");
    await cargarEstadoPuente();
  } catch (e) {
    setMessage(elements.puntualidadMessage, e?.message || "No se pudo resolver los nombres.", "error");
  } finally {
    setBusy(elements.puenteResolverButton, false);
  }
}

/* ==========================================================================
   Administracion > Fuera de horario (jornadas anomalas)
   ========================================================================== */

const JORNADA_TIPOS = {
  sentido_invertido: { etiqueta: "Sentido invertido", clase: "jt-invertido" },
  turno_cambiado:    { etiqueta: "Turno cambiado", clase: "jt-turno" },
  fuera_ventana:     { etiqueta: "Fuera de ventana", clase: "jt-ventana" },
  jornada_larga:     { etiqueta: "Jornada larga", clase: "jt-larga" },
  muy_corta:         { etiqueta: "Muy corta", clase: "jt-corta" },
  sin_cerrar:        { etiqueta: "Sin cerrar", clase: "jt-sincerrar" }
};

function setupJornadasDefaults() {
  if (!elements.jornadasDesdeInput || elements.jornadasDesdeInput.value) return;
  const hoy = getTodayParts().date;
  const corte = state.fechaCorteVerificacion;
  // Arranca en la fecha de corte (no se verifica nada anterior).
  const desde = new Date(`${hoy}T00:00:00`);
  desde.setDate(desde.getDate() - 29);
  let desdeStr = desde.toISOString().slice(0, 10);
  if (desdeStr < corte) desdeStr = corte;
  elements.jornadasDesdeInput.value = desdeStr;
  elements.jornadasHastaInput.value = hoy;
  elements.jornadasDesdeInput.min = corte;
  elements.jornadasHastaInput.min = corte;
}

async function cargarJornadasAnomalas() {
  const desde = elements.jornadasDesdeInput?.value;
  const hasta = elements.jornadasHastaInput?.value;
  if (!desde || !hasta) {
    setMessage(elements.jornadasMessage, "Selecciona el rango de fechas.", "error");
    return;
  }
  if (desde > hasta) {
    setMessage(elements.jornadasMessage, "La fecha inicial no puede ser mayor que la final.", "error");
    return;
  }

  setBusy(elements.jornadasBuscarButton, true);
  setMessage(elements.jornadasMessage, "");
  elements.jornadasStatus.textContent = "Analizando jornadas...";

  try {
    const { data, error } = await supabaseClient.rpc("reporte_jornadas_anomalas", {
      p_desde: desde, p_hasta: hasta
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || "No se pudo generar el reporte.");

    state.jornadasLoaded = true;
    state.jornadasData = data;
    state.jornadasFiltro = "";
    renderJornadasAnomalas();
  } catch (e) {
    elements.jornadasStatus.textContent = "No se pudo analizar las jornadas.";
    setMessage(elements.jornadasMessage, e?.message || "Error consultando jornadas.", "error");
  } finally {
    setBusy(elements.jornadasBuscarButton, false);
  }
}

function renderJornadasAnomalas() {
  const data = state.jornadasData;
  if (!data) return;
  const t = data.totales || {};
  const resumen = data.resumen || [];
  let detalle = data.detalle || [];

  elements.jornadasStatus.textContent =
    `${data.desde} a ${data.hasta} · solo se verifica desde ${state.fechaCorteVerificacion}`;

  // Chips de filtro por tipo.
  const chips = [["", "Todas", t.eventos || 0]];
  for (const [key, meta] of Object.entries(JORNADA_TIPOS)) {
    if (t[key]) chips.push([key, meta.etiqueta, t[key]]);
  }
  elements.jornadasFiltros.innerHTML = chips.map(([key, label, n]) =>
    `<button type="button" class="jornada-chip ${state.jornadasFiltro === key ? "activo" : ""}"
       data-jornada-filtro="${key}">${label} <span>${n}</span></button>`).join("");

  elements.jornadasTotales.innerHTML = `
    <div class="punt-card"><span>${t.conductores ?? 0}</span><small>conductores</small></div>
    <div class="punt-card falta"><span>${t.eventos ?? 0}</span><small>eventos</small></div>
    <div class="punt-card"><span>${t.sentido_invertido ?? 0}</span><small>trocados</small></div>
    <div class="punt-card"><span>${t.turno_cambiado ?? 0}</span><small>turno cambiado</small></div>
  `;

  if (!resumen.length) {
    elements.jornadasDetalleBox.classList.add("hidden");
    elements.jornadasResumenBox?.classList.add("hidden");
    setMessage(elements.jornadasMessage, "Sin jornadas anómalas en este rango. 👌", "success");
    return;
  }
  setMessage(elements.jornadasMessage, "");

  elements.jornadasResumenBox?.classList.remove("hidden");
  elements.jornadasResumen.innerHTML = `
    <table class="punt-tabla">
      <thead><tr>
        <th>Conductor</th><th>Cédula</th><th>Total</th>
        <th>Trocado</th><th>Turno camb.</th><th>Fuera vent.</th>
        <th>Larga</th><th>Corta</th><th>Sin cerrar</th>
      </tr></thead>
      <tbody>
        ${resumen.map((r) => `
          <tr>
            <td>${escapeHtml(r.nombre || "")}</td>
            <td>${escapeHtml(r.dni || "")}</td>
            <td><strong>${r.total}</strong></td>
            <td>${r.sentido_invertido || ""}</td>
            <td>${r.turno_cambiado || ""}</td>
            <td>${r.fuera_ventana || ""}</td>
            <td>${r.jornada_larga || ""}</td>
            <td>${r.muy_corta || ""}</td>
            <td>${r.sin_cerrar || ""}</td>
          </tr>`).join("")}
      </tbody>
    </table>
  `;

  if (state.jornadasFiltro) detalle = detalle.filter((d) => d.tipo === state.jornadasFiltro);

  elements.jornadasDetalleBox.classList.remove("hidden");
  elements.jornadasDetalle.innerHTML = `
    <table class="punt-tabla">
      <thead><tr>
        <th>Fecha</th><th>Conductor</th><th>Cédula</th><th>Base</th><th>Tipo</th><th>Turno</th>
        <th>Entrada</th><th>Prog. ingreso</th><th>Salida</th><th>Prog. salida</th>
        <th>Detalle</th><th>Vehículo</th><th>Acción</th>
      </tr></thead>
      <tbody>
        ${detalle.map((d) => {
          const meta = JORNADA_TIPOS[d.tipo] || { etiqueta: d.tipo, clase: "" };
          // La hora de la marca va en la columna que corresponde a su sentido.
          const entradaTxt = d.sentido === "entrada" ? (d.hora || "—") : "—";
          const salidaTxt = d.sentido === "salida" ? (d.hora || "—") : (d.hora_salida || "—");
          return `
          <tr>
            <td>${escapeHtml(d.fecha || "")}</td>
            <td>${escapeHtml(d.nombre || "")}</td>
            <td>${escapeHtml(d.dni || "")}</td>
            <td>${escapeHtml(d.base || "—")}</td>
            <td><span class="jornada-pill ${meta.clase}">${meta.etiqueta}</span></td>
            <td>${d.turno ?? "—"}</td>
            <td>${escapeHtml(entradaTxt)}</td>
            <td class="prog-hora">${escapeHtml(d.entrada_programada || "—")}</td>
            <td>${escapeHtml(salidaTxt)}</td>
            <td class="prog-hora">${escapeHtml(d.salida_programada || "—")}</td>
            <td>${describirJornada(d)}</td>
            <td>${escapeHtml(d.vehiculo || "")}</td>
            <td><button type="button" class="mini-btn jornada-corregir"
                  data-dni="${escapeHtml(d.dni || "")}" data-fecha="${escapeHtml(d.fecha || "")}">
                  Corregir</button></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;
}

// Salta a "Corregir horas" con la cedula y fecha del error precargadas.
function corregirDesdeError(dni, fecha) {
  showAdminSubtab("corregir");
  if (elements.corregirDniInput) elements.corregirDniInput.value = dni || "";
  if (elements.corregirDateInput) elements.corregirDateInput.value = fecha || "";
  if (dni && fecha) buscarCorregir();
  elements.corregirDniInput?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function exportarJornadasCsv() {
  const data = state.jornadasData;
  const detalle = data?.detalle || [];
  if (!detalle.length) {
    setMessage(elements.jornadasMessage, "Primero consulta un rango con errores para exportar.", "error");
    return;
  }
  const header = ["Fecha", "Cedula", "Conductor", "Base", "Tipo", "Turno",
    "Entrada", "Prog ingreso", "Salida", "Prog salida", "Detalle", "Vehiculo"];
  const esc = (v) => {
    const s = String(v ?? "");
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lineas = [header.join(";")];
  detalle.forEach((d) => {
    const meta = JORNADA_TIPOS[d.tipo] || { etiqueta: d.tipo };
    // La entrada real va en su columna; para trocados/sin-cerrar puede faltar una de las dos.
    const entradaReal = d.sentido === "entrada" ? (d.hora || "") : "";
    const salidaReal = d.sentido === "salida" ? (d.hora || "") : (d.hora_salida || "");
    lineas.push([d.fecha, d.dni, d.nombre, d.base || "", meta.etiqueta, d.turno ?? "",
      entradaReal, d.entrada_programada || "", salidaReal, d.salida_programada || "",
      describirJornada(d), d.vehiculo || ""]
      .map(esc).join(";"));
  });
  const blob = new Blob(["﻿" + lineas.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `errores_jornadas_${data.desde}_${data.hasta}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Frase corta que explica cada evento en lenguaje humano.
function describirJornada(d) {
  switch (d.tipo) {
    case "sentido_invertido":
      return "Marcó salida sin una entrada abierta";
    case "sin_cerrar":
      return "Entró pero no marcó salida";
    case "muy_corta":
      return d.horas != null ? `Jornada de ${d.horas} h` : "Jornada muy corta";
    case "jornada_larga":
      return d.horas != null ? `Jornada de ${d.horas} h` : "Jornada muy larga";
    case "turno_cambiado":
      return d.min_entrada != null
        ? `Entró ${Math.abs(Math.round(d.min_entrada / 60 * 10) / 10)} h ${d.min_entrada > 0 ? "después" : "antes"} de su turno`
        : "Trabajó el turno del otro conductor";
    case "fuera_ventana":
      return "Entrada y salida corridas 3 h o más";
    default:
      return "";
  }
}

/* ==========================================================================
   Administracion > Verificador de horarios
   Mismo reporte de jornadas anomalas, pero con la hora de ingreso y salida
   EDITABLE en la misma tabla (guarda via actualizar_marca_asistencia).
   ========================================================================== */

function setupVerificadorDefaults() {
  if (!elements.verificadorDesdeInput) return;
  const corte = state.fechaCorteVerificacion;

  // El tope se pone SIEMPRE, aunque las fechas ya esten puestas: no se verifica
  // nada anterior al corte y el calendario no debe ofrecerlo siquiera.
  elements.verificadorDesdeInput.min = corte;
  elements.verificadorHastaInput.min = corte;

  if (elements.verificadorDesdeInput.value) return;
  const hoy = getTodayParts().date;
  const desde = new Date(`${hoy}T00:00:00`);
  desde.setDate(desde.getDate() - 6); // por defecto, la última semana
  let desdeStr = desde.toISOString().slice(0, 10);
  if (desdeStr < corte) desdeStr = corte;
  elements.verificadorDesdeInput.value = desdeStr;
  elements.verificadorHastaInput.value = hoy;
}

// El `min` del input lo respeta el calendario, pero no siempre lo que se escribe a
// mano. Esto corrige la fecha en el acto para que nunca se consulte antes del corte.
function clampFechaVerificador(input) {
  const corte = state.fechaCorteVerificacion;
  if (!input?.value || input.value >= corte) return false;
  input.value = corte;
  setMessage(elements.verificadorMessage,
    `Solo se verifica desde el ${corte}: la fecha se ajustó a esa.`, "");
  return true;
}

async function cargarVerificador() {
  const desde = elements.verificadorDesdeInput?.value;
  const hasta = elements.verificadorHastaInput?.value;
  if (!desde || !hasta) {
    setMessage(elements.verificadorMessage, "Selecciona el rango de fechas.", "error");
    return;
  }
  if (desde > hasta) {
    setMessage(elements.verificadorMessage, "La fecha inicial no puede ser mayor que la final.", "error");
    return;
  }

  setBusy(elements.verificadorBuscarButton, true);
  setMessage(elements.verificadorMessage, "");
  elements.verificadorStatus.textContent = "Verificando horarios...";

  try {
    const { data, error } = await supabaseClient.rpc("reporte_jornadas_anomalas", {
      p_desde: desde, p_hasta: hasta
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || "No se pudo generar la verificación.");

    state.verificadorLoaded = true;
    state.verificadorModo = "errores";
    state.verificadorData = data;
    state.verificadorFiltro = "";
    renderVerificador();
  } catch (e) {
    elements.verificadorStatus.textContent = "No se pudo verificar los horarios.";
    setMessage(elements.verificadorMessage, e?.message || "Error consultando la verificación.", "error");
  } finally {
    setBusy(elements.verificadorBuscarButton, false);
  }
}

// Vista consolidada del DIA: todos los conductores programados de la fecha "Hasta",
// con su turno, la hora programada y la que marcaron (editable).
async function cargarVerificadorDia() {
  const fecha = elements.verificadorHastaInput?.value;
  if (!fecha) {
    setMessage(elements.verificadorMessage, "Selecciona la fecha en «Hasta».", "error");
    return;
  }

  setBusy(elements.verificadorDiaButton, true);
  setMessage(elements.verificadorMessage, "");
  elements.verificadorStatus.textContent = "Cargando el día completo...";

  try {
    const { data, error } = await supabaseClient.rpc("verificacion_dia", { p_fecha: fecha });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || "No se pudo cargar el día.");

    state.verificadorLoaded = true;
    state.verificadorModo = "dia";
    state.verificadorDiaData = data;
    renderVerificadorDia();
  } catch (e) {
    elements.verificadorStatus.textContent = "No se pudo cargar el día completo.";
    setMessage(elements.verificadorMessage, e?.message || "Error consultando el día.", "error");
  } finally {
    setBusy(elements.verificadorDiaButton, false);
  }
}

// Estado de una fila del día: compara lo programado con lo realmente marcado.
function estadoDia(x) {
  const hasEnt = !!x.entrada_id;
  const hasSal = !!x.salida_id;
  if (!hasEnt && !hasSal) return { txt: "Sin marcar", cls: "jt-sincerrar" };
  if (!hasEnt) return { txt: "Falta entrada", cls: "jt-invertido" };
  if (!hasSal) return { txt: "Falta salida", cls: "jt-sincerrar" };
  const ed = Math.abs(x.entrada_dif ?? 0);
  const sd = Math.abs(x.salida_dif ?? 0);
  if (ed > 60 || sd > 60) return { txt: "Diferencia", cls: "jt-ventana" };
  return { txt: "A tiempo", cls: "jt-ok" };
}

// Etiqueta corta de diferencia en minutos ("+5m" / "-12m" / "").
function difTxt(min) {
  if (min == null) return "";
  const n = Math.round(min);
  return `${n > 0 ? "+" : ""}${n}m`;
}

function renderVerificadorDia() {
  const data = state.verificadorDiaData;
  if (!data) return;
  let filas = data.filas || [];
  const total = filas.length;

  elements.verificadorStatus.textContent =
    `Día ${data.fecha} · ${total} turno(s) programado(s)`;

  // Totales según el estado.
  const cuenta = { sinmarca: 0, falta: 0, dif: 0, ok: 0 };
  filas.forEach((x) => {
    const e = estadoDia(x);
    if (e.txt === "Sin marcar") cuenta.sinmarca++;
    else if (e.txt.startsWith("Falta")) cuenta.falta++;
    else if (e.txt === "Diferencia") cuenta.dif++;
    else cuenta.ok++;
  });
  elements.verificadorFiltros.innerHTML = "";
  elements.verificadorTotales.innerHTML = `
    <div class="punt-card"><span>${total}</span><small>programados</small></div>
    <div class="punt-card"><span>${cuenta.ok}</span><small>a tiempo</small></div>
    <div class="punt-card falta"><span>${cuenta.dif}</span><small>con diferencia</small></div>
    <div class="punt-card falta"><span>${cuenta.falta + cuenta.sinmarca}</span><small>sin marca</small></div>
  `;

  // Filtro por texto (nombre / cédula / vehículo).
  const q = (elements.verificadorBuscarInput?.value || "").trim().toLowerCase();
  if (q) {
    filas = filas.filter((x) =>
      `${x.nombre || ""} ${x.dni || ""} ${x.vehiculo_prog || ""} ${x.entrada_veh || ""}`
        .toLowerCase().includes(q));
  }

  if (!filas.length) {
    elements.verificadorDetalle.innerHTML = "";
    setMessage(elements.verificadorMessage,
      total ? "Sin resultados con ese filtro." : "No hay programación para esa fecha.", "success");
    return;
  }
  setMessage(elements.verificadorMessage, "");

  const esc = (v) => escapeHtml(String(v ?? ""));
  elements.verificadorDetalle.innerHTML = `
    <table class="punt-tabla verif-tabla">
      <thead><tr>
        <th>Conductor</th><th>Cédula</th><th>Base</th><th>Turno</th><th>Veh. prog.</th>
        <th>Ingreso</th><th>Salida</th><th>Veh. real</th><th>Estado</th><th></th>
      </tr></thead>
      <tbody>
        ${filas.map((x) => {
          const est = estadoDia(x);
          const entHora = x.entrada_real || "";
          const salHora = x.salida_real || "";
          const entDis = x.entrada_id ? "" : "disabled";
          const salDis = x.salida_id ? "" : "disabled";
          const vehReal = x.entrada_veh || x.salida_veh || "";
          const vehDistinto = vehReal && x.vehiculo_prog
            && !String(vehReal).replace(/[^\dA-Za-z]/g, "").toUpperCase()
                 .includes(String(x.vehiculo_prog).replace(/[^\dA-Za-z]/g, "").toUpperCase());
          return `
          <tr class="verif-row"
              data-entrada-id="${esc(x.entrada_id || "")}" data-entrada-fecha="${esc(x.entrada_fecha || "")}"
              data-entrada-veh="${esc(x.entrada_veh || "")}" data-entrada-hora="${esc(entHora)}"
              data-salida-id="${esc(x.salida_id || "")}" data-salida-fecha="${esc(x.salida_fecha || "")}"
              data-salida-veh="${esc(x.salida_veh || "")}" data-salida-hora="${esc(salHora)}">
            <td>${esc(x.nombre)}</td>
            <td>${esc(x.dni)}</td>
            <td>${esc(x.base || "—")}</td>
            <td>${x.turno ?? "—"}</td>
            <td>${esc(x.vehiculo_prog || "—")}</td>
            <td class="verif-celda">
              ${horaInputHtml("entrada", entHora, !!entDis)}
              <small class="prog-hora">prog ${esc(x.entrada_prog || "—")}${x.entrada_id ? ` · ${difTxt(x.entrada_dif)}` : ""}</small>
            </td>
            <td class="verif-celda">
              ${horaInputHtml("salida", salHora, !!salDis)}
              <small class="prog-hora">prog ${esc(x.salida_prog || "—")}${x.salida_id ? ` · ${difTxt(x.salida_dif)}` : ""}</small>
            </td>
            <td>${esc(vehReal || "—")}${vehDistinto ? ` <span class="jornada-pill jt-turno">≠</span>` : ""}</td>
            <td><span class="jornada-pill ${est.cls}">${est.txt}</span></td>
            <td><button type="button" class="mini-btn verif-guardar">Guardar</button></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;
}

/* ---- Modo "Anticipos y excesos": quien entra antes y quien cierra despues ---- */

async function cargarVerificadorDesfases() {
  const desde = elements.verificadorDesdeInput?.value;
  const hasta = elements.verificadorHastaInput?.value;
  if (!desde || !hasta) {
    setMessage(elements.verificadorMessage, "Selecciona el rango de fechas.", "error");
    return;
  }
  if (desde > hasta) {
    setMessage(elements.verificadorMessage, "La fecha inicial no puede ser mayor que la final.", "error");
    return;
  }

  setBusy(elements.verificadorDesfasesButton, true);
  setMessage(elements.verificadorMessage, "");
  elements.verificadorStatus.textContent = "Calculando anticipos y excesos...";

  try {
    const { data, error } = await supabaseClient.rpc("reporte_desfases", {
      p_desde: desde, p_hasta: hasta
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || "No se pudo generar el reporte.");

    state.verificadorLoaded = true;
    state.verificadorModo = "desfases";
    state.verificadorDesfasesData = data;
    renderVerificadorDesfases();
  } catch (e) {
    elements.verificadorStatus.textContent = "No se pudo calcular los desfases.";
    setMessage(elements.verificadorMessage, e?.message || "Error consultando desfases.", "error");
  } finally {
    setBusy(elements.verificadorDesfasesButton, false);
  }
}

// "-45" -> "45 min antes" / "120" -> "2 h después". Habla en horas cuando pasa de 90.
function difLegible(min) {
  if (min === null || min === undefined) return "—";
  const n = Math.round(min);
  if (n === 0) return "en punto";
  const abs = Math.abs(n);
  const txt = abs >= 90
    ? `${(abs / 60).toFixed(1).replace(".0", "")} h`
    : `${abs} min`;
  return `${txt} ${n < 0 ? "antes" : "después"}`;
}

function renderVerificadorDesfases() {
  const data = state.verificadorDesfasesData;
  if (!data) return;
  const t = data.totales || {};
  let resumen = data.resumen || [];
  let detalle = data.detalle || [];

  elements.verificadorStatus.textContent =
    `${data.desde} a ${data.hasta} · ${t.marcas ?? 0} marcas con turno programado, ${t.conductores ?? 0} conductores`;
  elements.verificadorFiltros.innerHTML = "";

  elements.verificadorTotales.innerHTML = `
    <div class="punt-card"><span>${difLegible(t.prom_entrada).replace(" antes", "").replace(" después", "")}</span>
      <small>entrada promedio ${(t.prom_entrada ?? 0) < 0 ? "antes" : "después"}</small></div>
    <div class="punt-card"><span>${difLegible(t.prom_salida).replace(" antes", "").replace(" después", "")}</span>
      <small>salida promedio ${(t.prom_salida ?? 0) < 0 ? "antes" : "después"}</small></div>
    <div class="punt-card falta"><span>${t.ent_antes_60 ?? 0}</span>
      <small>entradas +1 h antes</small></div>
    <div class="punt-card falta"><span>${t.sal_despues_60 ?? 0}</span>
      <small>salidas +1 h después</small></div>
  `;

  // Filtro por texto sobre nombre / cédula / base.
  const q = (elements.verificadorBuscarInput?.value || "").trim().toLowerCase();
  if (q) {
    resumen = resumen.filter((x) => `${x.nombre || ""} ${x.dni || ""} ${x.base || ""}`.toLowerCase().includes(q));
    detalle = detalle.filter((x) => `${x.nombre || ""} ${x.dni || ""} ${x.base || ""}`.toLowerCase().includes(q));
  }

  if (!resumen.length) {
    elements.verificadorDetalle.innerHTML = "";
    setMessage(elements.verificadorMessage,
      (data.resumen || []).length ? "Sin resultados con ese filtro." : "Sin marcas con turno programado en el rango.", "success");
    return;
  }
  setMessage(elements.verificadorMessage, "");

  const esc = (v) => escapeHtml(String(v ?? ""));
  const chip = (min, tipo) => {
    // Anticipo al entrar y exceso al salir se resaltan segun el tamaño.
    const abs = Math.abs(min || 0);
    const cls = abs >= 120 ? "jt-invertido" : abs >= 60 ? "jt-corta" : "jt-ok";
    return `<span class="jornada-pill ${cls}">${difLegible(min)}</span>`;
  };

  elements.verificadorDetalle.innerHTML = `
    <h3 class="jornadas-subtitulo">Por conductor · ordenado por minutos de más</h3>
    <div class="tabla-scroll">
    <table class="punt-tabla">
      <thead><tr>
        <th>Conductor</th><th>Cédula</th><th>Base</th>
        <th>Entradas</th><th>Entrada promedio</th><th>Máx. anticipo</th><th>Veces +1 h antes</th>
        <th>Salidas</th><th>Salida promedio</th><th>Máx. exceso</th><th>Veces +1 h después</th>
        <th>Total de más</th>
      </tr></thead>
      <tbody>
        ${resumen.map((r) => `
          <tr>
            <td>${esc(r.nombre)}</td>
            <td>${esc(r.dni)}</td>
            <td>${esc(r.base || "—")}</td>
            <td>${r.n_entradas ?? 0}</td>
            <td>${r.n_entradas ? chip(r.prom_entrada) : "—"}</td>
            <td>${r.max_antes_entrada ? `<strong>${difLegible(-r.max_antes_entrada)}</strong>` : "—"}</td>
            <td>${r.veces_ent_antes_60 || ""}</td>
            <td>${r.n_salidas ?? 0}</td>
            <td>${r.n_salidas ? chip(r.prom_salida) : "—"}</td>
            <td>${r.max_despues_salida ? `<strong>${difLegible(r.max_despues_salida)}</strong>` : "—"}</td>
            <td>${r.veces_sal_despues_60 || ""}</td>
            <td><strong>${Math.round((r.exceso_total || 0) / 60 * 10) / 10} h</strong></td>
          </tr>`).join("")}
      </tbody>
    </table>
    </div>

    <details class="puntualidad-detalle">
      <summary>Ver las ${detalle.length} marcas con mayor desfase</summary>
      <div class="tabla-scroll">
      <table class="punt-tabla">
        <thead><tr>
          <th>Fecha</th><th>Conductor</th><th>Cédula</th><th>Base</th><th>Turno</th>
          <th>Tipo</th><th>Programada</th><th>Real</th><th>Desfase</th><th>Vehículo</th>
        </tr></thead>
        <tbody>
          ${detalle.map((d) => `
            <tr>
              <td>${esc(d.fecha)}</td>
              <td>${esc(d.nombre)}</td>
              <td>${esc(d.dni)}</td>
              <td>${esc(d.base || "—")}</td>
              <td>${d.turno ?? "—"}</td>
              <td>${d.sentido === "entrada" ? "Entrada" : "Salida"}</td>
              <td class="prog-hora">${esc(d.hora_programada || "—")}</td>
              <td><strong>${esc(d.hora || "—")}</strong></td>
              <td>${chip(d.dif)}</td>
              <td>${esc(d.vehiculo || "")}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      </div>
    </details>
  `;
}

/* ---- Modo "Gestores y auxiliares": personal SIN programacion de turnos ---- */

const GESTOR_TIPOS = {
  sin_cerrar:    { etiqueta: "Sin cerrar", clase: "jt-sincerrar" },
  jornada_larga: { etiqueta: "Duración imposible", clase: "jt-larga" },
  muy_corta:     { etiqueta: "Marca doble", clase: "jt-corta" }
};

async function cargarVerificadorGestores() {
  const desde = elements.verificadorDesdeInput?.value;
  const hasta = elements.verificadorHastaInput?.value;
  if (!desde || !hasta) {
    setMessage(elements.verificadorMessage, "Selecciona el rango de fechas.", "error");
    return;
  }
  if (desde > hasta) {
    setMessage(elements.verificadorMessage, "La fecha inicial no puede ser mayor que la final.", "error");
    return;
  }

  setBusy(elements.verificadorGestoresButton, true);
  setMessage(elements.verificadorMessage, "");
  elements.verificadorStatus.textContent = "Validando gestores y auxiliares...";

  try {
    const { data, error } = await supabaseClient.rpc("validacion_sin_programacion", {
      p_desde: desde, p_hasta: hasta
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || "No se pudo generar la validación.");

    state.verificadorLoaded = true;
    state.verificadorModo = "gestores";
    state.verificadorGestoresData = data;
    renderVerificadorGestores();
  } catch (e) {
    elements.verificadorStatus.textContent = "No se pudo validar el personal sin programación.";
    setMessage(elements.verificadorMessage, e?.message || "Error consultando la validación.", "error");
  } finally {
    setBusy(elements.verificadorGestoresButton, false);
  }
}

function renderVerificadorGestores() {
  const data = state.verificadorGestoresData;
  if (!data) return;
  const t = data.totales || {};
  let detalle = data.detalle || [];
  let resumen = (data.resumen || []).filter((r) => r.novedades > 0);

  elements.verificadorStatus.textContent =
    `${data.desde} a ${data.hasta} · ${t.personas ?? 0} personas sin programación, `
    + `${t.jornadas ?? 0} jornadas (mediana ${t.duracion_mediana ?? "—"} h)`;
  elements.verificadorFiltros.innerHTML = "";

  elements.verificadorTotales.innerHTML = `
    <div class="punt-card"><span>${t.jornadas ?? 0}</span><small>jornadas</small></div>
    <div class="punt-card falta"><span>${t.con_novedad ?? 0}</span><small>con novedad</small></div>
    <div class="punt-card falta"><span>${t.sin_cerrar ?? 0}</span><small>sin cerrar</small></div>
    <div class="punt-card falta"><span>${t.jornada_larga ?? 0}</span><small>duración imposible</small></div>
  `;

  const q = (elements.verificadorBuscarInput?.value || "").trim().toLowerCase();
  if (q) {
    const coincide = (x) => `${x.nombre || ""} ${x.dni || ""} ${x.cargo || ""}`.toLowerCase().includes(q);
    detalle = detalle.filter(coincide);
    resumen = resumen.filter(coincide);
  }

  if (!detalle.length) {
    elements.verificadorDetalle.innerHTML = "";
    setMessage(elements.verificadorMessage,
      (data.detalle || []).length ? "Sin resultados con ese filtro."
        : `Sin novedades en las jornadas del personal sin programación. 👌`, "success");
    return;
  }
  setMessage(elements.verificadorMessage, "");

  const esc = (v) => escapeHtml(String(v ?? ""));
  elements.verificadorDetalle.innerHTML = `
    <p class="field-hint">Se valida la <strong>jornada</strong>, no el horario: este personal rota
    turno (hay quien entra desde las 00:04 hasta las 23:49), así que no hay hora programada contra
    la cual compararlo. Una jornada normal dura entre 8 y 16 h; se marca lo que pasa de
    <strong>${data.horas_max ?? 18} h</strong>.</p>
    <div class="tabla-scroll">
    <table class="punt-tabla verif-tabla">
      <thead><tr>
        <th>Fecha</th><th>Persona</th><th>Cédula</th><th>Cargo</th><th>Novedad</th>
        <th>Entrada</th><th>Salida</th><th>Duración</th><th></th>
      </tr></thead>
      <tbody>
        ${detalle.map((d) => {
          const meta = GESTOR_TIPOS[d.tipo] || { etiqueta: d.tipo, clase: "" };
          return `
          <tr class="verif-row"
              data-entrada-id="${esc(d.entrada_id || "")}" data-entrada-fecha="${esc(d.entrada_fecha || "")}"
              data-entrada-veh="" data-entrada-hora="${esc(d.entrada_hora || "")}"
              data-salida-id="${esc(d.salida_id || "")}" data-salida-fecha="${esc(d.salida_fecha || "")}"
              data-salida-veh="" data-salida-hora="${esc(d.salida_hora || "")}">
            <td>${esc(d.fecha)}</td>
            <td>${esc(d.nombre)}</td>
            <td>${esc(d.dni)}</td>
            <td>${esc(d.cargo || "—")}</td>
            <td><span class="jornada-pill ${meta.clase}">${meta.etiqueta}</span></td>
            <td class="verif-celda">${horaInputHtml("entrada", d.entrada_hora, !d.entrada_id)}</td>
            <td class="verif-celda">${horaInputHtml("salida", d.salida_hora, !d.salida_id)}</td>
            <td>${d.horas != null ? `<strong>${d.horas} h</strong>` : "<em>abierta</em>"}</td>
            <td><button type="button" class="mini-btn verif-guardar">Guardar</button></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
    </div>

    ${resumen.length ? `
    <details class="puntualidad-detalle">
      <summary>Ver resumen por persona (${resumen.length} con novedades)</summary>
      <div class="tabla-scroll">
      <table class="punt-tabla">
        <thead><tr>
          <th>Persona</th><th>Cédula</th><th>Cargo</th><th>Jornadas</th><th>Novedades</th>
          <th>Sin cerrar</th><th>Duración imposible</th><th>Marca doble</th>
          <th>Duración promedio</th><th>Máxima</th>
        </tr></thead>
        <tbody>
          ${resumen.map((r) => `
            <tr>
              <td>${esc(r.nombre)}</td>
              <td>${esc(r.dni)}</td>
              <td>${esc(r.cargo || "—")}</td>
              <td>${r.jornadas ?? 0}</td>
              <td><strong>${r.novedades ?? 0}</strong></td>
              <td>${r.sin_cerrar || ""}</td>
              <td>${r.jornada_larga || ""}</td>
              <td>${r.muy_corta || ""}</td>
              <td>${r.duracion_promedio != null ? r.duracion_promedio + " h" : "—"}</td>
              <td>${r.duracion_max != null ? r.duracion_max + " h" : "—"}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      </div>
    </details>` : ""}
  `;
}

/* --------------------------------------------------------------------------
   Cierres declarados: la bitacora de los turnos que se cerraron a mano.
   Responde tres preguntas que antes no tenian respuesta: a que hora dijo el
   operario que termino, por que no quedo la marca, y quien lo declaro y cuando.
   -------------------------------------------------------------------------- */

async function cargarVerificadorCierres() {
  const desde = elements.verificadorDesdeInput?.value;
  const hasta = elements.verificadorHastaInput?.value;
  if (!desde || !hasta) {
    setMessage(elements.verificadorMessage, "Selecciona el rango de fechas.", "error");
    return;
  }
  if (desde > hasta) {
    setMessage(elements.verificadorMessage, "La fecha inicial no puede ser mayor que la final.", "error");
    return;
  }

  setBusy(elements.verificadorCierresButton, true);
  setMessage(elements.verificadorMessage, "");
  elements.verificadorStatus.textContent = "Consultando cierres declarados...";

  try {
    const { data, error } = await supabaseClient.rpc("reporte_cierres_turno", {
      p_desde: desde, p_hasta: hasta
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || "No se pudo generar la bitácora.");

    state.verificadorLoaded = true;
    state.verificadorModo = "cierres";
    state.verificadorCierresData = data;
    renderVerificadorCierres();
  } catch (e) {
    elements.verificadorStatus.textContent = "No se pudo consultar la bitácora de cierres.";
    setMessage(elements.verificadorMessage, e?.message || "Error consultando la bitácora.", "error");
  } finally {
    setBusy(elements.verificadorCierresButton, false);
  }
}

function renderVerificadorCierres() {
  const data = state.verificadorCierresData;
  if (!data) return;
  const t = data.totales || {};
  let detalle = data.detalle || [];

  elements.verificadorStatus.textContent =
    `${data.desde} a ${data.hasta} · ${t.cierres ?? 0} turnos cerrados a mano`
    + ` · solo se verifica desde ${data.corte || state.fechaCorteVerificacion}`;
  elements.verificadorFiltros.innerHTML = "";

  const retraso = t.retraso_mediano;
  elements.verificadorTotales.innerHTML = `
    <div class="punt-card"><span>${t.cierres ?? 0}</span><small>cierres declarados</small></div>
    <div class="punt-card"><span>${t.personas ?? 0}</span><small>personas</small></div>
    <div class="punt-card falta"><span>${t.corregidos ?? 0}</span><small>corregidos después</small></div>
    <div class="punt-card"><span>${retraso != null ? retraso + " h" : "—"}</span><small>retraso mediano</small></div>
  `;

  const q = (elements.verificadorBuscarInput?.value || "").trim().toLowerCase();
  if (q) {
    detalle = detalle.filter((x) =>
      `${x.nombre || ""} ${x.dni || ""} ${x.motivo || ""} ${x.declarado_nombre || ""}`
        .toLowerCase().includes(q));
  }

  if (!detalle.length) {
    elements.verificadorDetalle.innerHTML = "";
    setMessage(elements.verificadorMessage,
      (data.detalle || []).length
        ? "Sin resultados con ese filtro."
        : "No se cerró ningún turno a mano en ese rango. 👌", "success");
    return;
  }
  setMessage(elements.verificadorMessage, "");

  const esc = (v) => escapeHtml(String(v ?? ""));
  const motivos = data.motivos || [];

  elements.verificadorDetalle.innerHTML = `
    <p class="field-hint">Cada fila es un turno que quedó <strong>sin marca de salida</strong> y que
    alguien cerró declarando la hora. La marca creada no es biométrica y no se envía a Buk: queda
    aquí para que se revise. El <strong>retraso</strong> es cuánto tiempo después del hecho se
    declaró; mientras más alto, más tarde se detectó la brecha.</p>

    <div class="tabla-scroll">
    <table class="punt-tabla verif-tabla">
      <thead><tr>
        <th>Entrada</th><th>Persona</th><th>Cédula</th><th>Cargo</th>
        <th>Salida declarada</th><th>Programada</th><th>Ajuste</th>
        <th>Jornada</th><th>Motivo</th><th>Declaró</th><th>Cuándo</th><th>Retraso</th>
      </tr></thead>
      <tbody>
        ${detalle.map((d) => {
          const aj = d.minutos_ajuste;
          const ajTxt = aj == null ? "—"
            : aj === 0 ? "en punto"
            : `${Math.abs(aj)} min ${aj > 0 ? "después" : "antes"}`;
          const horaMostrada = d.hora_actual || d.hora_declarada;
          return `
          <tr class="${d.corregida ? "ct-corregida" : ""}">
            <td>${esc(d.entrada_fecha)}<br><small>${esc(d.entrada_hora)}</small></td>
            <td>${esc(d.nombre)}</td>
            <td>${esc(d.dni)}</td>
            <td>${esc(d.cargo || "—")}</td>
            <td><strong>${esc(horaMostrada)}</strong>${d.corregida
                ? `<br><small class="punt-warn">declaró ${esc(d.hora_declarada)}, corregida</small>` : ""}</td>
            <td>${esc(d.hora_programada || "—")}</td>
            <td class="${aj ? "punt-warn" : ""}">${esc(ajTxt)}</td>
            <td>${d.horas_jornada != null ? `<strong>${d.horas_jornada} h</strong>` : "—"}</td>
            <td class="ct-motivo">${esc(d.motivo)}</td>
            <td>${esc(d.declarado_nombre || "—")}</td>
            <td><small>${esc(d.declarado_at)}</small></td>
            <td class="${d.horas_retraso > 24 ? "punt-warn" : ""}">${
              d.horas_retraso != null ? d.horas_retraso + " h" : "—"}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
    </div>

    ${motivos.length ? `
    <details class="puntualidad-detalle" open>
      <summary>Por qué no se cerraron (${motivos.length} motivos distintos)</summary>
      <div class="tabla-scroll">
      <table class="punt-tabla">
        <thead><tr><th>Motivo</th><th>Veces</th></tr></thead>
        <tbody>
          ${motivos.map((m) => `
            <tr><td>${esc(m.motivo)}</td><td><strong>${m.veces}</strong></td></tr>`).join("")}
        </tbody>
      </table>
      </div>
    </details>` : ""}
  `;
}

/* --------------------------------------------------------------------------
   Jornadas de mas de 16 h: la novedad que Buk rechaza.
   Las crea un trigger en la base, asi que ninguna se pierde aunque la marca se
   haya hecho por otra via. Lo que importa aqui es la columna "sin explicar":
   son las que nadie ha respondido todavia.
   -------------------------------------------------------------------------- */

async function cargarVerificadorExcedidas() {
  const desde = elements.verificadorDesdeInput?.value;
  const hasta = elements.verificadorHastaInput?.value;
  if (!desde || !hasta) {
    setMessage(elements.verificadorMessage, "Selecciona el rango de fechas.", "error");
    return;
  }
  if (desde > hasta) {
    setMessage(elements.verificadorMessage, "La fecha inicial no puede ser mayor que la final.", "error");
    return;
  }

  setBusy(elements.verificadorExcedidasButton, true);
  setMessage(elements.verificadorMessage, "");
  elements.verificadorStatus.textContent = "Consultando jornadas extendidas...";

  try {
    const { data, error } = await supabaseClient.rpc("reporte_jornadas_excedidas", {
      p_desde: desde, p_hasta: hasta
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || "No se pudo generar el reporte.");

    state.verificadorLoaded = true;
    state.verificadorModo = "excedidas";
    state.verificadorExcedidasData = data;
    renderVerificadorExcedidas();
  } catch (e) {
    elements.verificadorStatus.textContent = "No se pudieron consultar las jornadas extendidas.";
    setMessage(elements.verificadorMessage, e?.message || "Error consultando el reporte.", "error");
  } finally {
    setBusy(elements.verificadorExcedidasButton, false);
  }
}

function renderVerificadorExcedidas() {
  const data = state.verificadorExcedidasData;
  if (!data) return;
  const t = data.totales || {};
  const limite = data.limite ?? LIMITE_HORAS_JORNADA;
  let detalle = data.detalle || [];

  elements.verificadorStatus.textContent =
    `${data.desde} a ${data.hasta} · ${t.jornadas ?? 0} jornadas de más de ${limite} h`
    + ` · solo se verifica desde ${data.corte || state.fechaCorteVerificacion}`;
  elements.verificadorFiltros.innerHTML = "";

  elements.verificadorTotales.innerHTML = `
    <div class="punt-card"><span>${t.jornadas ?? 0}</span><small>jornadas +${limite} h</small></div>
    <div class="punt-card falta"><span>${t.sin_explicar ?? 0}</span><small>sin explicar</small></div>
    <div class="punt-card falta"><span>${t.rechazadas_buk ?? 0}</span><small>rechazadas por Buk</small></div>
    <div class="punt-card"><span>${t.horas_max != null ? t.horas_max + " h" : "—"}</span><small>la más larga</small></div>
  `;

  const q = (elements.verificadorBuscarInput?.value || "").trim().toLowerCase();
  if (q) {
    detalle = detalle.filter((x) =>
      `${x.nombre || ""} ${x.dni || ""} ${x.motivo || ""} ${x.explicado_nombre || ""}`
        .toLowerCase().includes(q));
  }

  if (!detalle.length) {
    elements.verificadorDetalle.innerHTML = "";
    setMessage(elements.verificadorMessage,
      (data.detalle || []).length
        ? "Sin resultados con ese filtro."
        : `Ninguna jornada pasó de ${limite} h en ese rango. 👌`, "success");
    return;
  }
  setMessage(elements.verificadorMessage, "");

  const esc = (v) => escapeHtml(String(v ?? ""));
  const motivos = data.motivos || [];

  elements.verificadorDetalle.innerHTML = `
    <p class="field-hint">Buk rechaza toda jornada de más de <strong>${limite} h</strong>
    ("las marcas excedieron el máximo de horas permitidas"), así que estas marcas están en
    nuestra base pero <strong>no entraron a nómina</strong>. El límite no es arbitrario:
    sobre 9.603 jornadas, por debajo de 16 h el rechazo es del 0,1&nbsp;%, y entre 16 y 17 h
    fueron 26 de 26. Las filas en rojo son las que <strong>nadie ha explicado todavía</strong>.
    <br>Se verifica <strong>estrictamente desde el ${esc(data.corte || state.fechaCorteVerificacion)}</strong>:
    una jornada solo cuenta si la entrada <em>y</em> la salida caen de esa fecha en adelante.
    ${data.recortado ? `<strong class="punt-warn">El rango pedido se recortó al corte.</strong>` : ""}</p>

    <div class="tabla-scroll">
    <table class="punt-tabla verif-tabla">
      <thead><tr>
        <th>Entrada</th><th>Salida</th><th>Persona</th><th>Cédula</th><th>Cargo</th>
        <th>Jornada</th><th>Exceso</th><th>Buk</th>
        <th>Explicación</th><th>Explicó</th><th>Cuándo</th>
      </tr></thead>
      <tbody>
        ${detalle.map((d) => `
          <tr class="${d.sin_explicar ? "je-sinexplicar" : ""}">
            <td>${esc(d.entrada_fecha || "—")}<br><small>${esc(d.entrada_hora || "")}</small></td>
            <td>${esc(d.salida_fecha)}<br><small>${esc(d.salida_hora)}</small></td>
            <td>${esc(d.nombre)}</td>
            <td>${esc(d.dni)}</td>
            <td>${esc(d.cargo || "—")}</td>
            <td><strong class="punt-warn">${d.horas} h</strong></td>
            <td>+${d.exceso_horas} h</td>
            <td>${d.rechazada_buk
                  ? `<span class="jornada-pill jt-larga">Rechazada</span>`
                  : (d.enviado_buk ? `<span class="jornada-pill jt-ok">Aceptada</span>`
                                   : `<span class="jornada-pill jt-sincerrar">Sin enviar</span>`)}</td>
            <td class="ct-motivo">${d.sin_explicar
                  ? `<strong class="punt-warn">SIN EXPLICAR</strong>` : esc(d.motivo)}</td>
            <td>${esc(d.explicado_nombre || "—")}</td>
            <td><small>${esc(d.explicado_at || "—")}</small></td>
          </tr>`).join("")}
      </tbody>
    </table>
    </div>

    ${motivos.length ? `
    <details class="puntualidad-detalle" open>
      <summary>Por qué se extendieron (${motivos.length} motivos distintos)</summary>
      <div class="tabla-scroll">
      <table class="punt-tabla">
        <thead><tr><th>Motivo</th><th>Veces</th></tr></thead>
        <tbody>
          ${motivos.map((m) => `
            <tr><td>${esc(m.motivo)}</td><td><strong>${m.veces}</strong></td></tr>`).join("")}
        </tbody>
      </table>
      </div>
    </details>` : ""}
  `;
}

/* --------------------------------------------------------------------------
   Marcó con novedad: quien registro asistencia teniendo una novedad ese dia.
   El cruce es por nombre normalizado por tokens, porque `novedades` no tiene
   cedula y el orden de las palabras no es igual entre las dos fuentes.
   -------------------------------------------------------------------------- */

async function cargarVerificadorNovedades() {
  const desde = elements.verificadorDesdeInput?.value;
  const hasta = elements.verificadorHastaInput?.value;
  if (!desde || !hasta) {
    setMessage(elements.verificadorMessage, "Selecciona el rango de fechas.", "error");
    return;
  }
  if (desde > hasta) {
    setMessage(elements.verificadorMessage, "La fecha inicial no puede ser mayor que la final.", "error");
    return;
  }

  setBusy(elements.verificadorNovedadesButton, true);
  setMessage(elements.verificadorMessage, "");
  elements.verificadorStatus.textContent = "Cruzando marcas con novedades...";

  try {
    const { data, error } = await supabaseClient.rpc("reporte_marcas_con_novedad", {
      p_desde: desde, p_hasta: hasta
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || "No se pudo generar el reporte.");

    state.verificadorLoaded = true;
    state.verificadorModo = "novedades";
    state.verificadorNovedadesData = data;
    renderVerificadorNovedades();
  } catch (e) {
    elements.verificadorStatus.textContent = "No se pudo cruzar marcas con novedades.";
    setMessage(elements.verificadorMessage, e?.message || "Error consultando el reporte.", "error");
  } finally {
    setBusy(elements.verificadorNovedadesButton, false);
  }
}

function renderVerificadorNovedades() {
  const data = state.verificadorNovedadesData;
  if (!data) return;
  const t = data.totales || {};
  let detalle = data.detalle || [];

  elements.verificadorStatus.textContent =
    `${data.desde} a ${data.hasta} · ${t.dias ?? 0} días con marca y novedad`
    + ` · solo se verifica desde ${data.corte || state.fechaCorteVerificacion}`;
  elements.verificadorFiltros.innerHTML = "";

  elements.verificadorTotales.innerHTML = `
    <div class="punt-card"><span>${t.dias ?? 0}</span><small>días con novedad</small></div>
    <div class="punt-card"><span>${t.personas ?? 0}</span><small>personas</small></div>
    <div class="punt-card falta"><span>${t.incompatibles ?? 0}</span><small>no debían estar</small></div>
    <div class="punt-card"><span>${t.con_programacion ?? 0}</span><small>además tenían turno</small></div>
  `;

  const q = (elements.verificadorBuscarInput?.value || "").trim().toLowerCase();
  if (q) {
    detalle = detalle.filter((x) =>
      `${x.nombre || ""} ${x.dni || ""} ${x.estado || ""} ${x.cargo || ""}`
        .toLowerCase().includes(q));
  }

  if (!detalle.length) {
    elements.verificadorDetalle.innerHTML = "";
    setMessage(elements.verificadorMessage,
      (data.detalle || []).length
        ? "Sin resultados con ese filtro."
        : "Nadie marcó teniendo una novedad en ese rango. 👌", "success");
    return;
  }
  setMessage(elements.verificadorMessage, "");

  const esc = (v) => escapeHtml(String(v ?? ""));
  const estados = data.estados || [];

  elements.verificadorDetalle.innerHTML = `
    <p class="field-hint">Estas personas <strong>registraron asistencia</strong> el mismo día en
    que la programación las reportaba con una novedad. Marcar en <strong>DESCANSO</strong> puede
    ser legítimo —le pidieron cubrir un turno—, pero tiene que quedar visible. Marcar en
    <strong>INCAPACITADO, VACACIONES o RENUNCIA</strong> no lo es: esas van en rojo.
    <br>El cruce es <strong>por nombre</strong>, porque la tabla de novedades no guarda cédula.</p>

    <div class="tabla-scroll">
    <table class="punt-tabla verif-tabla">
      <thead><tr>
        <th>Fecha</th><th>Persona</th><th>Cédula</th><th>Cargo</th>
        <th>Novedad</th><th>Base</th><th>Entrada</th><th>Salida</th>
        <th>Marcas</th><th>¿Tenía turno?</th>
      </tr></thead>
      <tbody>
        ${detalle.map((d) => `
          <tr class="${d.incompatible ? "je-sinexplicar" : ""}">
            <td>${esc(d.fecha)}</td>
            <td>${esc(d.nombre)}</td>
            <td>${esc(d.dni)}</td>
            <td>${esc(d.cargo || "—")}</td>
            <td><span class="jornada-pill ${d.incompatible ? "jt-larga" : "jt-sincerrar"}">${esc(d.estado)}</span></td>
            <td>${esc(d.base_novedad || "—")}</td>
            <td>${esc(d.entrada || "—")}</td>
            <td>${esc(d.salida || "—")}</td>
            <td>${d.marcas ?? 0}</td>
            <td>${d.tenia_programacion
                  ? `<span class="jornada-pill jt-ok">Sí</span>`
                  : "<em>no</em>"}</td>
          </tr>`).join("")}
      </tbody>
    </table>
    </div>

    ${estados.length ? `
    <details class="puntualidad-detalle" open>
      <summary>Resumen por estado (${estados.length})</summary>
      <div class="tabla-scroll">
      <table class="punt-tabla">
        <thead><tr><th>Estado</th><th>Días</th><th>Personas</th><th>¿Compatible con laborar?</th></tr></thead>
        <tbody>
          ${estados.map((e) => `
            <tr>
              <td>${esc(e.estado)}</td>
              <td><strong>${e.veces}</strong></td>
              <td>${e.personas}</td>
              <td>${e.incompatible
                    ? `<strong class="punt-warn">No</strong>` : "Sí"}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      </div>
    </details>` : ""}
  `;
}

// Re-render según el modo activo (lo usa el filtro de texto).
function rerenderVerificador() {
  if (state.verificadorModo === "dia") renderVerificadorDia();
  else if (state.verificadorModo === "desfases") renderVerificadorDesfases();
  else if (state.verificadorModo === "gestores") renderVerificadorGestores();
  else if (state.verificadorModo === "cierres") renderVerificadorCierres();
  else if (state.verificadorModo === "excedidas") renderVerificadorExcedidas();
  else if (state.verificadorModo === "novedades") renderVerificadorNovedades();
  else renderVerificador();
}

function renderVerificador() {
  const data = state.verificadorData;
  if (!data) return;
  const t = data.totales || {};
  let detalle = data.detalle || [];

  elements.verificadorStatus.textContent =
    `${data.desde} a ${data.hasta} · solo se verifica desde ${state.fechaCorteVerificacion}`;

  // Chips de filtro por tipo.
  const chips = [["", "Todas", t.eventos || 0]];
  for (const [key, meta] of Object.entries(JORNADA_TIPOS)) {
    if (t[key]) chips.push([key, meta.etiqueta, t[key]]);
  }
  elements.verificadorFiltros.innerHTML = chips.map(([key, label, n]) =>
    `<button type="button" class="jornada-chip ${state.verificadorFiltro === key ? "activo" : ""}"
       data-verif-filtro="${key}">${label} <span>${n}</span></button>`).join("");

  elements.verificadorTotales.innerHTML = `
    <div class="punt-card"><span>${t.conductores ?? 0}</span><small>conductores</small></div>
    <div class="punt-card falta"><span>${t.eventos ?? 0}</span><small>errores</small></div>
    <div class="punt-card"><span>${t.sentido_invertido ?? 0}</span><small>trocados</small></div>
    <div class="punt-card"><span>${t.fuera_ventana ?? 0}</span><small>fuera ventana</small></div>
  `;

  // Filtro por tipo (chip) y por texto (nombre / cédula / vehículo).
  if (state.verificadorFiltro) detalle = detalle.filter((d) => d.tipo === state.verificadorFiltro);
  const q = (elements.verificadorBuscarInput?.value || "").trim().toLowerCase();
  if (q) {
    detalle = detalle.filter((d) =>
      `${d.nombre || ""} ${d.dni || ""} ${d.vehiculo || ""}`.toLowerCase().includes(q));
  }

  if (!detalle.length) {
    elements.verificadorDetalle.innerHTML = "";
    setMessage(elements.verificadorMessage,
      (data.totales?.eventos ? "Sin resultados con ese filtro." : "Sin errores de horario en este rango. 👌"),
      "success");
    return;
  }
  setMessage(elements.verificadorMessage, "");

  const esc = (v) => escapeHtml(String(v ?? ""));
  elements.verificadorDetalle.innerHTML = `
    <table class="punt-tabla verif-tabla">
      <thead><tr>
        <th>Fecha</th><th>Conductor</th><th>Cédula</th><th>Base</th><th>Vehículo</th>
        <th>Tipo</th><th>Turno</th><th>Ingreso</th><th>Salida</th><th>Detalle</th><th></th>
      </tr></thead>
      <tbody>
        ${detalle.map((d) => {
          const meta = JORNADA_TIPOS[d.tipo] || { etiqueta: d.tipo, clase: "" };
          const entHora = d.entrada_hora || "";
          const salHora = d.salida_hora || "";
          const entDis = d.entrada_id ? "" : "disabled";
          const salDis = d.salida_id ? "" : "disabled";
          return `
          <tr class="verif-row"
              data-entrada-id="${esc(d.entrada_id || "")}" data-entrada-fecha="${esc(d.entrada_fecha || "")}"
              data-entrada-veh="${esc(d.entrada_vehiculo || "")}" data-entrada-hora="${esc(entHora)}"
              data-salida-id="${esc(d.salida_id || "")}" data-salida-fecha="${esc(d.salida_fecha || "")}"
              data-salida-veh="${esc(d.salida_vehiculo || "")}" data-salida-hora="${esc(salHora)}">
            <td>${esc(d.fecha)}</td>
            <td>${esc(d.nombre)}</td>
            <td>${esc(d.dni)}</td>
            <td>${esc(d.base || "—")}</td>
            <td>${esc(d.vehiculo || "")}</td>
            <td><span class="jornada-pill ${meta.clase}">${meta.etiqueta}</span></td>
            <td>${d.turno ?? "—"}</td>
            <td class="verif-celda">
              ${horaInputHtml("entrada", entHora, !!entDis)}
              <small class="prog-hora">prog ${esc(d.entrada_programada || "—")}</small>
            </td>
            <td class="verif-celda">
              ${horaInputHtml("salida", salHora, !!salDis)}
              <small class="prog-hora">prog ${esc(d.salida_programada || "—")}</small>
            </td>
            <td>${describirJornada(d)}</td>
            <td><button type="button" class="mini-btn verif-guardar">Guardar</button></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;
}

// Normaliza una hora escrita a mano al formato 24 h "HH:MM". Acepta "2338", "23:38",
// "6:02", "0602". Devuelve null si es una hora invalida y "" si esta vacia.
function normalizeHoraInput(valor) {
  let s = String(valor || "").trim();
  if (!s) return "";
  s = s.replace(/[^\d:]/g, "");
  let h, m;
  if (s.includes(":")) {
    [h, m] = s.split(":");
  } else if (s.length <= 2) {
    h = s; m = "0";
  } else {
    m = s.slice(-2); h = s.slice(0, -2);
  }
  h = parseInt(h, 10);
  m = parseInt(m, 10);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Campo de hora editable (24 h) con un botón de reloj que abre el selector nativo y
// un botón para eliminar esa marca. Lo elegido en el reloj se copia al campo (24 h).
function horaInputHtml(sentido, hora, disabled) {
  const extraClass = sentido === "entrada" ? "verif-ent-hora" : "verif-sal-hora";
  const val = escapeHtml(String(hora || ""));
  if (disabled) {
    return `<input type="text" class="verif-hora ${extraClass}" value="${val}" placeholder="--:--" disabled>`;
  }
  return `<span class="verif-hora-wrap">`
    + `<input type="text" inputmode="numeric" maxlength="5" placeholder="HH:MM"`
    + ` class="verif-hora ${extraClass}" value="${val}">`
    + `<button type="button" class="verif-hora-pick" tabindex="-1" aria-label="Elegir hora en el reloj">🕐</button>`
    + `<button type="button" class="verif-borrar" data-sentido="${sentido}" tabindex="-1" aria-label="Eliminar esta marca">🗑</button>`
    + `<input type="time" step="60" class="verif-hora-native" value="${val}" tabindex="-1" aria-hidden="true">`
    + `</span>`;
}

// Guarda las horas editadas de una fila (entrada y/o salida) reusando el RPC de
// correccion. Solo envia las que cambiaron; reenvia fecha y vehiculo sin tocar.
async function guardarHorasVerificador(rowEl) {
  if (!rowEl) return;
  const cambios = [];
  const entInput = rowEl.querySelector(".verif-ent-hora");
  const salInput = rowEl.querySelector(".verif-sal-hora");

  if (rowEl.dataset.entradaId && entInput && !entInput.disabled) {
    const val = normalizeHoraInput(entInput.value);
    if (val === null) {
      setMessage(elements.verificadorMessage, "La hora de ingreso no es válida (usa HH:MM en 24 h).", "error");
      entInput.focus();
      return;
    }
    if (val && val !== rowEl.dataset.entradaHora) {
      entInput.value = val;
      cambios.push({ id: rowEl.dataset.entradaId, fecha: rowEl.dataset.entradaFecha,
        hora: val, sentido: "entrada", vehiculo: rowEl.dataset.entradaVeh || null });
    }
  }
  if (rowEl.dataset.salidaId && salInput && !salInput.disabled) {
    const val = normalizeHoraInput(salInput.value);
    if (val === null) {
      setMessage(elements.verificadorMessage, "La hora de salida no es válida (usa HH:MM en 24 h).", "error");
      salInput.focus();
      return;
    }
    if (val && val !== rowEl.dataset.salidaHora) {
      salInput.value = val;
      cambios.push({ id: rowEl.dataset.salidaId, fecha: rowEl.dataset.salidaFecha,
        hora: val, sentido: "salida", vehiculo: rowEl.dataset.salidaVeh || null });
    }
  }

  if (!cambios.length) {
    setMessage(elements.verificadorMessage, "No cambiaste ninguna hora en esa fila.", "");
    return;
  }

  const ok = await confirmGraphical(
    "Guardar horas corregidas",
    `¿Guardar ${cambios.length === 2 ? "la entrada y la salida" : "la hora"} de esta jornada? `
    + "Solo se cambia en la base local (no en Buk).",
    "Sí, guardar", "Cancelar"
  );
  if (!ok) return;

  const btn = rowEl.querySelector(".verif-guardar");
  setBusy(btn, true);
  try {
    for (const c of cambios) {
      const horaFull = c.hora.length === 5 ? `${c.hora}:00` : c.hora;
      const { data, error } = await supabaseClient.rpc("actualizar_marca_asistencia", {
        p_id: c.id, p_fecha: c.fecha, p_hora: horaFull, p_sentido: c.sentido,
        p_vehiculo: c.vehiculo || null
      });
      if (error || !data?.ok) throw new Error(error?.message || data?.error || "error");
      // Actualiza el "original" para no re-guardar lo mismo.
      if (c.sentido === "entrada") rowEl.dataset.entradaHora = c.hora;
      else rowEl.dataset.salidaHora = c.hora;
    }
    // Marca visual: esta fila ya quedó corregida ("✓ Guardado").
    rowEl.classList.add("verif-guardado");
    if (btn) { btn.classList.add("ok"); btn.textContent = "✓ Guardado"; }
    setMessage(elements.verificadorMessage,
      `✅ ${cambios.length} hora(s) actualizada(s). Vuelve a verificar para recalcular.`, "success");
  } catch (e) {
    setMessage(elements.verificadorMessage, `No se pudo guardar: ${e.message || e}`, "error");
  } finally {
    setBusy(btn, false);
  }
}

// Elimina una marca (entrada o salida) de una fila del verificador. Util para las
// salidas huerfanas / duplicadas que no tienen una entrada que editar.
async function borrarMarcaVerificador(rowEl, sentido) {
  if (!rowEl || !sentido) return;
  const id = sentido === "entrada" ? rowEl.dataset.entradaId : rowEl.dataset.salidaId;
  if (!id) {
    setMessage(elements.verificadorMessage, "Esa jornada no tiene una marca de ese tipo para eliminar.", "");
    return;
  }
  const hora = sentido === "entrada" ? rowEl.dataset.entradaHora : rowEl.dataset.salidaHora;
  const fecha = sentido === "entrada" ? rowEl.dataset.entradaFecha : rowEl.dataset.salidaFecha;

  const ok = await confirmGraphical(
    "Eliminar marca",
    `¿Eliminar la marca de ${sentido.toUpperCase()} del ${fecha || ""} a las ${hora || "--:--"}? `
    + "Esta acción no se puede deshacer y NO la quita de Buk.",
    "Sí, eliminar", "Cancelar"
  );
  if (!ok) return;

  try {
    const { data, error } = await supabaseClient.rpc("eliminar_asistencia", { p_id: id });
    if (error || !data?.ok) throw new Error(error?.message || data?.error || "error");
    setMessage(elements.verificadorMessage, "🗑 Marca eliminada. Actualizando...", "success");
    // Recarga para recalcular el estado tras el borrado.
    if (state.verificadorModo === "dia") await cargarVerificadorDia();
    else if (state.verificadorModo === "desfases") await cargarVerificadorDesfases();
    else if (state.verificadorModo === "gestores") await cargarVerificadorGestores();
    else if (state.verificadorModo === "cierres") await cargarVerificadorCierres();
    else if (state.verificadorModo === "excedidas") await cargarVerificadorExcedidas();
    else if (state.verificadorModo === "novedades") await cargarVerificadorNovedades();
    else await cargarVerificador();
  } catch (e) {
    setMessage(elements.verificadorMessage, `No se pudo eliminar: ${e.message || e}`, "error");
  }
}

function exportarVerificadorCsv() {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  let header, lineas, nombreArchivo;

  if (state.verificadorModo === "novedades") {
    const data = state.verificadorNovedadesData;
    const filas = data?.detalle || [];
    if (!filas.length) {
      setMessage(elements.verificadorMessage, "Primero consulta un rango con novedades.", "error");
      return;
    }
    header = ["Fecha", "Cedula", "Persona", "Cargo", "Novedad", "Base novedad",
      "Incompatible con laborar", "Entrada", "Salida", "Marcas", "Tenia turno programado"];
    lineas = [header.join(";")];
    filas.forEach((d) => {
      lineas.push([d.fecha, d.dni, d.nombre, d.cargo || "", d.estado, d.base_novedad || "",
        d.incompatible ? "SI" : "NO", d.entrada || "", d.salida || "", d.marcas ?? 0,
        d.tenia_programacion ? "SI" : "NO"].map(esc).join(";"));
    });
    nombreArchivo = `marcas_con_novedad_${data.desde}_${data.hasta}.csv`;
  } else if (state.verificadorModo === "excedidas") {
    const data = state.verificadorExcedidasData;
    const filas = data?.detalle || [];
    if (!filas.length) {
      setMessage(elements.verificadorMessage, "Primero consulta un rango con jornadas extendidas.", "error");
      return;
    }
    header = ["Fecha entrada", "Hora entrada", "Fecha salida", "Hora salida", "Cedula",
      "Persona", "Cargo", "Jornada (h)", "Limite (h)", "Exceso (h)", "Rechazada por Buk",
      "Enviada a Buk", "Error Buk", "Explicacion", "Sin explicar", "Explico", "Explicado el"];
    lineas = [header.join(";")];
    filas.forEach((d) => {
      lineas.push([d.entrada_fecha || "", d.entrada_hora || "", d.salida_fecha, d.salida_hora,
        d.dni, d.nombre, d.cargo || "", d.horas, d.limite_horas, d.exceso_horas,
        d.rechazada_buk ? "SI" : "NO", d.enviado_buk ? "SI" : "NO", d.buk_error || "",
        d.motivo || "", d.sin_explicar ? "SI" : "NO",
        d.explicado_nombre || "", d.explicado_at || ""]
        .map(esc).join(";"));
    });
    nombreArchivo = `jornadas_extendidas_${data.desde}_${data.hasta}.csv`;
  } else if (state.verificadorModo === "cierres") {
    const data = state.verificadorCierresData;
    const filas = data?.detalle || [];
    if (!filas.length) {
      setMessage(elements.verificadorMessage, "Primero consulta un rango con cierres para exportar.", "error");
      return;
    }
    header = ["Fecha entrada", "Hora entrada", "Cedula", "Persona", "Cargo",
      "Fecha salida", "Hora declarada", "Hora actual", "Corregida", "Hora programada",
      "Ajuste (min)", "Jornada (h)", "Motivo", "Declarado por", "Declarado el", "Retraso (h)"];
    lineas = [header.join(";")];
    filas.forEach((d) => {
      lineas.push([d.entrada_fecha, d.entrada_hora, d.dni, d.nombre, d.cargo || "",
        d.salida_fecha, d.hora_declarada, d.hora_actual || "", d.corregida ? "SI" : "NO",
        d.hora_programada || "", d.minutos_ajuste ?? "", d.horas_jornada ?? "",
        d.motivo, d.declarado_nombre || "", d.declarado_at || "", d.horas_retraso ?? ""]
        .map(esc).join(";"));
    });
    nombreArchivo = `cierres_declarados_${data.desde}_${data.hasta}.csv`;
  } else if (state.verificadorModo === "gestores") {
    const data = state.verificadorGestoresData;
    const filas = data?.detalle || [];
    if (!filas.length) {
      setMessage(elements.verificadorMessage, "Primero consulta un rango con novedades para exportar.", "error");
      return;
    }
    header = ["Fecha", "Cedula", "Persona", "Cargo", "Novedad", "Entrada", "Salida", "Duracion (h)"];
    lineas = [header.join(";")];
    filas.forEach((d) => {
      const meta = GESTOR_TIPOS[d.tipo] || { etiqueta: d.tipo };
      lineas.push([d.fecha, d.dni, d.nombre, d.cargo || "", meta.etiqueta,
        d.entrada_hora || "", d.salida_hora || "", d.horas ?? ""]
        .map(esc).join(";"));
    });
    nombreArchivo = `gestores_auxiliares_${data.desde}_${data.hasta}.csv`;
  } else if (state.verificadorModo === "desfases") {
    const data = state.verificadorDesfasesData;
    const filas = data?.resumen || [];
    if (!filas.length) {
      setMessage(elements.verificadorMessage, "Primero consulta un rango para exportar.", "error");
      return;
    }
    header = ["Cedula", "Conductor", "Base", "Entradas", "Entrada promedio (min)",
      "Max anticipo entrada (min)", "Veces +1h antes", "Salidas", "Salida promedio (min)",
      "Max exceso salida (min)", "Veces +1h despues", "Total de mas (min)"];
    lineas = [header.join(";")];
    filas.forEach((r) => {
      lineas.push([r.dni, r.nombre, r.base || "", r.n_entradas ?? 0, r.prom_entrada ?? "",
        r.max_antes_entrada ?? "", r.veces_ent_antes_60 ?? 0, r.n_salidas ?? 0, r.prom_salida ?? "",
        r.max_despues_salida ?? "", r.veces_sal_despues_60 ?? 0, r.exceso_total ?? 0]
        .map(esc).join(";"));
    });
    // Segundo bloque en el mismo archivo: el detalle marca por marca.
    lineas.push("");
    lineas.push(["Fecha", "Cedula", "Conductor", "Base", "Turno", "Tipo",
      "Hora programada", "Hora real", "Desfase (min)", "Vehiculo"].join(";"));
    (data.detalle || []).forEach((d) => {
      lineas.push([d.fecha, d.dni, d.nombre, d.base || "", d.turno ?? "",
        d.sentido === "entrada" ? "Entrada" : "Salida",
        d.hora_programada || "", d.hora || "", d.dif ?? "", d.vehiculo || ""]
        .map(esc).join(";"));
    });
    nombreArchivo = `anticipos_excesos_${data.desde}_${data.hasta}.csv`;
  } else if (state.verificadorModo === "dia") {
    const data = state.verificadorDiaData;
    const filas = data?.filas || [];
    if (!filas.length) {
      setMessage(elements.verificadorMessage, "Primero carga un día con programación para exportar.", "error");
      return;
    }
    header = ["Fecha", "Cedula", "Conductor", "Base", "Turno", "Veh programado",
      "Entrada prog", "Entrada real", "Dif entrada (min)",
      "Salida prog", "Salida real", "Dif salida (min)", "Veh real", "Estado"];
    lineas = [header.join(";")];
    filas.forEach((x) => {
      lineas.push([data.fecha, x.dni, x.nombre, x.base || "", x.turno ?? "", x.vehiculo_prog || "",
        x.entrada_prog || "", x.entrada_real || "", x.entrada_dif ?? "",
        x.salida_prog || "", x.salida_real || "", x.salida_dif ?? "",
        x.entrada_veh || x.salida_veh || "", estadoDia(x).txt]
        .map(esc).join(";"));
    });
    nombreArchivo = `dia_completo_${data.fecha}.csv`;
  } else {
    const data = state.verificadorData;
    const detalle = data?.detalle || [];
    if (!detalle.length) {
      setMessage(elements.verificadorMessage, "Primero verifica un rango con errores para exportar.", "error");
      return;
    }
    header = ["Fecha", "Cedula", "Conductor", "Base", "Tipo", "Turno",
      "Entrada", "Prog ingreso", "Salida", "Prog salida", "Detalle", "Vehiculo"];
    lineas = [header.join(";")];
    detalle.forEach((d) => {
      const meta = JORNADA_TIPOS[d.tipo] || { etiqueta: d.tipo };
      lineas.push([d.fecha, d.dni, d.nombre, d.base || "", meta.etiqueta, d.turno ?? "",
        d.entrada_hora || "", d.entrada_programada || "", d.salida_hora || "", d.salida_programada || "",
        describirJornada(d), d.vehiculo || ""]
        .map(esc).join(";"));
    });
    nombreArchivo = `verificador_horarios_${data.desde}_${data.hasta}.csv`;
  }

  const blob = new Blob(["﻿" + lineas.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombreArchivo;
  a.click();
  URL.revokeObjectURL(url);
}

/* ==========================================================================
   Administracion > Horario programado
   ========================================================================== */

function setupHorarioDefaults() {
  if (!elements.horarioDesdeInput || elements.horarioDesdeInput.value) return;
  const hoy = getTodayParts().date;
  // Por defecto muestra el dia de hoy.
  elements.horarioDesdeInput.value = hoy;
  elements.horarioHastaInput.value = hoy;
}

async function cargarHorario() {
  const desde = elements.horarioDesdeInput?.value;
  const hasta = elements.horarioHastaInput?.value;
  const buscar = elements.horarioBuscarInput?.value.trim() || null;

  if (!desde || !hasta) {
    setMessage(elements.horarioMessage, "Selecciona el rango de fechas.", "error");
    return;
  }
  if (desde > hasta) {
    setMessage(elements.horarioMessage, "La fecha inicial no puede ser mayor que la final.", "error");
    return;
  }

  setBusy(elements.horarioBuscarButton, true);
  setMessage(elements.horarioMessage, "");
  elements.horarioStatus.textContent = "Consultando horario...";

  try {
    const { data, error } = await supabaseClient.rpc("horario_programado", {
      p_desde: desde, p_hasta: hasta, p_buscar: buscar
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || "No se pudo consultar el horario.");

    state.horarioLoaded = true;
    state.horarioFilas = data.filas || [];
    renderHorario(data);
  } catch (e) {
    elements.horarioStatus.textContent = "No se pudo consultar el horario.";
    setMessage(elements.horarioMessage, e?.message || "Error consultando el horario.", "error");
  } finally {
    setBusy(elements.horarioBuscarButton, false);
  }
}

function renderHorario(data) {
  const filas = data.filas || [];
  const rango = data.desde === data.hasta ? data.desde : `${data.desde} a ${data.hasta}`;
  elements.horarioStatus.textContent =
    `${rango} · ${data.total} turno(s)` + (data.mostrados < data.total ? ` (mostrando ${data.mostrados})` : "");

  if (!filas.length) {
    elements.horarioResultado.innerHTML =
      `<p class="field-hint">No hay programación para ese rango o búsqueda.</p>`;
    return;
  }

  const multiDia = data.desde !== data.hasta;
  elements.horarioResultado.innerHTML = `
    <table class="punt-tabla">
      <thead><tr>
        ${multiDia ? "<th>Fecha</th>" : ""}
        <th>Turno</th><th>Conductor</th><th>Cédula</th>
        <th>Entrada</th><th>Salida</th><th>Vehículo</th><th>Base</th><th>Puesto</th>
      </tr></thead>
      <tbody>
        ${filas.map((f) => `
          <tr>
            ${multiDia ? `<td>${escapeHtml(f.fecha || "")}</td>` : ""}
            <td><span class="turno-pill turno-${f.turno}">T${f.turno}</span></td>
            <td>${escapeHtml(f.conductor || "")}</td>
            <td>${escapeHtml(f.dni || "—")}</td>
            <td><strong>${escapeHtml(f.entrada || "--:--")}</strong></td>
            <td><strong>${escapeHtml(f.salida || "--:--")}</strong></td>
            <td>${escapeHtml(f.vehiculo || "")}</td>
            <td>${escapeHtml(f.base || "")}</td>
            <td>${escapeHtml(f.puesto || "")}</td>
          </tr>`).join("")}
      </tbody>
    </table>
  `;
}

function exportarHorarioCsv() {
  const filas = state.horarioFilas;
  if (!filas.length) {
    setMessage(elements.horarioMessage, "Primero consulta un horario para exportar.", "error");
    return;
  }
  const header = ["Fecha", "Turno", "Conductor", "Cedula", "Entrada", "Salida", "Vehiculo", "Base", "Puesto"];
  const esc = (v) => {
    const s = String(v ?? "");
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lineas = [header.join(";")];
  filas.forEach((f) => {
    lineas.push([f.fecha, `T${f.turno}`, f.conductor, f.dni, f.entrada, f.salida, f.vehiculo, f.base, f.puesto]
      .map(esc).join(";"));
  });
  const blob = new Blob(["﻿" + lineas.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `horario_${elements.horarioDesdeInput.value}_${elements.horarioHastaInput.value}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ==========================================================================
   Administracion > Mapa de posiciones de las marcas
   Grafica donde se hizo cada registro biometrico (lat/lon de asistencias) para
   verificar que las marcas se tomen en los puntos correctos.
   ========================================================================== */

function setupMapaDefaults() {
  if (!elements.mapaDesdeInput || elements.mapaDesdeInput.value) return;
  const hoy = getTodayParts().date;
  elements.mapaDesdeInput.value = hoy;
  elements.mapaHastaInput.value = hoy;
}

// Inicializa el mapa Leaflet una sola vez.
function ensureMapaMap() {
  if (state.mapaMap || typeof window.L === "undefined" || !elements.mapaMarcas) return state.mapaMap;
  // Vista inicial: Medellin.
  state.mapaMap = window.L.map(elements.mapaMarcas, { scrollWheelZoom: true }).setView([6.2442, -75.5812], 12);
  window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap"
  }).addTo(state.mapaMap);
  state.mapaLayer = window.L.layerGroup().addTo(state.mapaMap);
  return state.mapaMap;
}

async function cargarMapaMarcas() {
  const desde = elements.mapaDesdeInput?.value;
  const hasta = elements.mapaHastaInput?.value;
  const buscar = elements.mapaBuscarInput?.value.trim() || null;

  if (!desde || !hasta) {
    setMessage(elements.mapaMessage, "Selecciona el rango de fechas.", "error");
    return;
  }
  if (desde > hasta) {
    setMessage(elements.mapaMessage, "La fecha inicial no puede ser mayor que la final.", "error");
    return;
  }
  if (typeof window.L === "undefined") {
    setMessage(elements.mapaMessage, "No se pudo cargar el mapa (Leaflet).", "error");
    return;
  }

  setBusy(elements.mapaBuscarButton, true);
  setMessage(elements.mapaMessage, "");
  elements.mapaStatus.textContent = "Cargando marcas...";

  try {
    const { data, error } = await supabaseClient.rpc("marcas_con_ubicacion", {
      p_desde: desde, p_hasta: hasta, p_buscar: buscar
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || "No se pudo cargar el mapa.");

    state.mapaLoaded = true;
    renderMapaMarcas(data);
  } catch (e) {
    elements.mapaStatus.textContent = "No se pudieron cargar las marcas.";
    setMessage(elements.mapaMessage, e?.message || "Error cargando el mapa.", "error");
  } finally {
    setBusy(elements.mapaBuscarButton, false);
  }
}

function renderMapaMarcas(data) {
  ensureMapaMap();
  if (!state.mapaMap) return;

  state.mapaLayer.clearLayers();
  const marcas = data.marcas || [];

  const rango = data.desde === data.hasta ? data.desde : `${data.desde} a ${data.hasta}`;
  elements.mapaStatus.textContent =
    `${rango} · ${data.total} marca(s)` + (data.mostrados < data.total ? ` (mostrando ${data.mostrados})` : "");

  if (!marcas.length) {
    elements.mapaMessage.textContent = "";
    setMessage(elements.mapaMessage, "No hay marcas con ubicación en ese rango.", "error");
    setTimeout(() => state.mapaMap.invalidateSize(), 120);
    return;
  }

  const puntos = [];
  marcas.forEach((m) => {
    const esEntrada = m.sentido === "entrada";
    const color = esEntrada ? "#0a6b3b" : "#c2410c";
    // Circulo de precision GPS (tenue).
    if (m.precision > 0) {
      window.L.circle([m.lat, m.lon], {
        radius: m.precision, color, weight: 1, opacity: 0.25, fillOpacity: 0.05
      }).addTo(state.mapaLayer);
    }
    const marker = window.L.circleMarker([m.lat, m.lon], {
      radius: 6, color: "#fff", weight: 1, fillColor: color, fillOpacity: 0.9
    }).addTo(state.mapaLayer);
    marker.bindPopup(`
      <strong>${escapeHtml(m.nombre || "")}</strong><br>
      Cédula: ${escapeHtml(m.dni || "")}<br>
      ${esEntrada ? "🟢 Entrada" : "🟠 Salida"} · ${escapeHtml(m.fecha)} ${escapeHtml(m.hora)}<br>
      ${m.vehiculo ? `Vehículo: ${escapeHtml(m.vehiculo)}<br>` : ""}
      Precisión: ${m.precision} m · Origen: ${escapeHtml(m.origen || "")}<br>
      <a href="https://www.google.com/maps?q=${m.lat},${m.lon}" target="_blank" rel="noopener">Ver en Google Maps</a>
    `);
    puntos.push([m.lat, m.lon]);
  });

  // Ajusta el zoom para que se vean todas las marcas.
  try {
    state.mapaMap.fitBounds(window.L.latLngBounds(puntos).pad(0.15));
  } catch (_) {}
  setTimeout(() => state.mapaMap.invalidateSize(), 120);
}

/* ==========================================================================
   Administracion > Fichos de salida Base 3
   ========================================================================== */

function setupBase3Defaults() {
  if (!elements.base3DateInput || elements.base3DateInput.value) return;
  elements.base3DateInput.value = getTodayParts().date;
}

async function cargarBase3() {
  const fecha = elements.base3DateInput?.value;
  if (!fecha) {
    setMessage(elements.base3Message, "Selecciona una fecha.", "error");
    return;
  }

  setBusy(elements.base3BuscarButton, true);
  setMessage(elements.base3Message, "");
  elements.base3Status.textContent = "Consultando fichos...";

  try {
    const { data, error } = await supabaseClient.rpc("horario_base3", { p_fecha: fecha });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || "No se pudo consultar los fichos.");

    state.base3Loaded = true;
    state.base3Filas = data.filas || [];
    renderBase3(data);
  } catch (e) {
    elements.base3Status.textContent = "No se pudo consultar los fichos.";
    setMessage(elements.base3Message, e?.message || "Error consultando los fichos.", "error");
  } finally {
    setBusy(elements.base3BuscarButton, false);
  }
}

function renderBase3(data) {
  const filas = data.filas || [];
  elements.base3Status.textContent = `${data.fecha} · ${data.total} ficho(s) en Base 3`;

  if (!filas.length) {
    elements.base3Resultado.innerHTML =
      `<p class="field-hint">No hay fichos programados en Base 3 para esa fecha.</p>`;
    return;
  }

  elements.base3Resultado.innerHTML = `
    <table class="punt-tabla">
      <thead><tr>
        <th>Ficho</th><th>Vehículo</th><th>Inicia</th><th>Inicia 2</th><th>Hora fin</th><th>Puesto</th>
      </tr></thead>
      <tbody>
        ${filas.map((f) => `
          <tr>
            <td><span class="ficho-pill">${escapeHtml(f.ficho || "")}</span></td>
            <td><strong>${escapeHtml(f.vehiculo || "")}</strong></td>
            <td>${escapeHtml(f.inicia || "--:--")}</td>
            <td>${escapeHtml(f.inicia2 || "--:--")}</td>
            <td>${escapeHtml(f.hora_fin || "--:--")}</td>
            <td>${escapeHtml(f.puesto || "")}</td>
          </tr>`).join("")}
      </tbody>
    </table>
  `;
}

function exportarBase3Csv() {
  const filas = state.base3Filas;
  if (!filas.length) {
    setMessage(elements.base3Message, "Primero consulta una fecha para exportar.", "error");
    return;
  }
  const header = ["Ficho", "Vehiculo", "Inicia", "Inicia 2", "Hora fin", "Puesto"];
  const esc = (v) => {
    const s = String(v ?? "");
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lineas = [header.join(";")];
  filas.forEach((f) => {
    lineas.push([f.ficho, f.vehiculo, f.inicia, f.inicia2, f.hora_fin, f.puesto].map(esc).join(";"));
  });
  const blob = new Blob(["﻿" + lineas.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `fichos_base3_${elements.base3DateInput.value}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function showAdminSubtab(name) {
  const valid = ["alerts", "abiertos", "marcas", "jornadas", "rechazos", "inconsistencias", "validacion", "sinmarca", "corregir", "puntualidad", "jornadas-anomalas", "verificador", "horario", "mapa", "colaboradores", "perfilsociodemografico", "rostros", "sonar"];
  const target = valid.includes(name) ? name : "alerts";
  document.querySelectorAll("[data-admin-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.adminTab === target);
    btn.setAttribute("aria-selected", btn.dataset.adminTab === target ? "true" : "false");
  });
  document.querySelectorAll("[data-admin-content]").forEach((node) => {
    node.classList.toggle("hidden", node.dataset.adminContent !== target);
  });
  state.adminSubtab = target;

  if (target === "jornadas") {
    setupJournalDefaults();
    if (!state.journalLoaded) loadJournalMarks();
  }

  if (target === "rechazos") {
    setupRechazoDefaults();
    if (!state.rechazoLoaded) loadRechazoMarks();
  }

  if (target === "inconsistencias") {
    setupInconsistDefaults();
    if (!state.inconsistLoaded) loadInconsistMarks();
  }

  if (target === "sinmarca") {
    if (!state.sinMarcaLoaded) loadSinMarca();
  }

  if (target === "puntualidad") {
    setupPuntualidadDefaults();
    if (!state.puntualidadLoaded) cargarPuntualidad();
    cargarEstadoPuente();
  }

  if (target === "jornadas-anomalas") {
    setupJornadasDefaults();
    if (!state.jornadasLoaded) cargarJornadasAnomalas();
  }

  if (target === "verificador") {
    setupVerificadorDefaults();
    if (!state.verificadorLoaded) cargarVerificador();
  }

  if (target === "horario") {
    setupHorarioDefaults();
    if (!state.horarioLoaded) cargarHorario();
  }

  if (target === "mapa") {
    setupMapaDefaults();
    // El mapa necesita el contenedor visible para calcular su tamaño.
    setTimeout(() => {
      ensureMapaMap();
      state.mapaMap?.invalidateSize();
      if (!state.mapaLoaded) cargarMapaMarcas();
    }, 60);
  }

  if (target === "colaboradores" && !state.csvLoaded) {
    loadCollaboratorsCsv();
  }

  if (target === "perfilsociodemografico" && !state.perfilSocioLoaded) {
    loadPerfilSociodemografico();
  }

  if (target === "validacion") {
    setupValidacionDefaults();
    if (!state.validacionLoaded) loadValidacionTurnos();
  }

  if (target === "corregir" && elements.corregirDateInput && !elements.corregirDateInput.value) {
    elements.corregirDateInput.value = getTodayParts().date;
  }
}

// ---- Tutorial "¿Cómo marcar?" (modal con pasos ilustrados) ----
const TUTORIAL_STORAGE_KEY = "tutorial_marca_visto";
const TUTORIAL_STEPS = [
  {
    icon: "search",
    titulo: "Valida la cédula",
    texto: "Digita la cédula del colaborador y toca “Validar”. La app confirma que esté activo antes de continuar."
  },
  {
    icon: "camera",
    titulo: "Toma la foto",
    texto: "Toca “Abrir cámara” y captura una foto clara del rostro. La foto es obligatoria como evidencia de la marca."
  },
  {
    icon: "map-pin",
    titulo: "Activa la ubicación",
    texto: "La ubicación es obligatoria. Se activa sola; si no aparece, toca la caja del mapa o el botón “Activar ubicación” y permite el acceso al GPS."
  },
  {
    icon: "log-in",
    titulo: "Revisa el tipo de marca",
    texto: "Entrada o Salida se define solo, según el turno programado del conductor. Si de verdad no corresponde, puedes corregirlo confirmando el cambio."
  },
  {
    icon: "message-circle",
    titulo: "Registra (y comprobante opcional)",
    texto: "Si el conductor quiere el comprobante por WhatsApp, digita su celular. Luego toca el botón verde “Registrar asistencia”. ¡Listo!"
  }
];

function renderTutorialStep() {
  const total = TUTORIAL_STEPS.length;
  const i = Math.min(Math.max(state.tutorialStep || 0, 0), total - 1);
  const step = TUTORIAL_STEPS[i];

  elements.tutorialIcon.innerHTML = `<i data-lucide="${step.icon}"></i>`;
  elements.tutorialStepNum.textContent = `Paso ${i + 1} de ${total}`;
  elements.tutorialTitle.textContent = step.titulo;
  elements.tutorialText.textContent = step.texto;

  elements.tutorialDots.innerHTML = TUTORIAL_STEPS
    .map((_, idx) => `<span class="${idx === i ? "active" : ""}"></span>`)
    .join("");

  elements.tutorialPrev.disabled = i === 0;
  elements.tutorialNext.textContent = i === total - 1 ? "Entendido" : "Siguiente";

  if (window.lucide?.createIcons) {
    try { window.lucide.createIcons(); } catch (_) {}
  }
}

function openTutorial() {
  state.tutorialStep = 0;
  elements.tutorialOverlay.classList.remove("hidden");
  renderTutorialStep();
}

function closeTutorial() {
  elements.tutorialOverlay.classList.add("hidden");
  state.tutorialSeenSession = true; // respaldo en memoria si el storage está bloqueado
  try { localStorage.setItem(TUTORIAL_STORAGE_KEY, "1"); } catch (_) {}
}

function tutorialNext() {
  if (state.tutorialStep >= TUTORIAL_STEPS.length - 1) {
    closeTutorial();
    return;
  }
  state.tutorialStep += 1;
  renderTutorialStep();
}

function tutorialPrev() {
  if (state.tutorialStep <= 0) return;
  state.tutorialStep -= 1;
  renderTutorialStep();
}

// Se muestra automáticamente la primera vez que el usuario ve el registro.
function maybeShowTutorial() {
  if (state.tutorialSeenSession) return;
  if (elements.tutorialOverlay && !elements.tutorialOverlay.classList.contains("hidden")) return;
  let visto = false;
  try { visto = localStorage.getItem(TUTORIAL_STORAGE_KEY) === "1"; } catch (_) {}
  if (!visto) openTutorial();
}

// ---- Clave del panel de Administración (verificada en el servidor) ----
// Usa una bandera EN MEMORIA como fuente principal (state.adminUnlocked) y el
// sessionStorage solo como respaldo. Así funciona aunque el contenedor (WebView /
// iframe) bloquee el almacenamiento ("Tracking Prevention blocked storage").
function isAdminUnlocked() {
  if (state.adminUnlocked) return true;
  try {
    if (sessionStorage.getItem("admin_unlocked") === "1") {
      state.adminUnlocked = true;
      return true;
    }
  } catch (_) { /* storage bloqueado: nos quedamos con la bandera en memoria */ }
  return false;
}

// Pide la clave y la valida contra el servidor (RPC verificar_clave_admin, que la
// compara con la guardada en Vault). Devuelve una promesa que resuelve true/false.
function requireAdminClave() {
  if (isAdminUnlocked()) return Promise.resolve(true);
  return new Promise((resolve) => {
    elements.adminClaveInput.value = "";
    elements.adminClaveError.classList.add("hidden");
    elements.adminClaveOverlay.classList.remove("hidden");
    setTimeout(() => elements.adminClaveInput.focus(), 60);

    const cleanup = () => {
      elements.adminClaveOverlay.classList.add("hidden");
      elements.adminClaveAccept.removeEventListener("click", onAccept);
      elements.adminClaveCancel.removeEventListener("click", onCancel);
      elements.adminClaveInput.removeEventListener("keydown", onKey);
    };
    const onAccept = async () => {
      const clave = elements.adminClaveInput.value;
      if (!clave) return;
      elements.adminClaveAccept.disabled = true;
      const { data, error } = await supabaseClient.rpc("verificar_clave_admin", { p_clave: clave });
      elements.adminClaveAccept.disabled = false;
      if (!error && data === true) {
        state.adminUnlocked = true;
        try { sessionStorage.setItem("admin_unlocked", "1"); } catch (_) {}
        cleanup();
        resolve(true);
      } else {
        elements.adminClaveError.classList.remove("hidden");
        elements.adminClaveInput.value = "";
        elements.adminClaveInput.focus();
      }
    };
    const onCancel = () => { cleanup(); resolve(false); };
    const onKey = (event) => { if (event.key === "Enter") { event.preventDefault(); onAccept(); } };
    elements.adminClaveAccept.addEventListener("click", onAccept);
    elements.adminClaveCancel.addEventListener("click", onCancel);
    elements.adminClaveInput.addEventListener("keydown", onKey);
  });
}

function showTab(tabName) {
  // El panel de Administración exige clave: si no está desbloqueado, no se muestra.
  if (tabName === "admin" && !isAdminUnlocked()) {
    tabName = "register";
  }
  const esTabAdmin = tabName === "admin" || tabName === "manualexit";
  // Las pestañas de admin no estan disponibles si no es admin, o si esta en movil.
  if (esTabAdmin && (!state.isAdmin || state.deviceMode === "mobile")) {
    tabName = "register";
  }

  const isHistory = tabName === "history";
  const isBase3 = tabName === "base3";
  const isAdmin = tabName === "admin";
  const isManualExit = tabName === "manualexit";
  elements.registerPanel.classList.toggle("hidden", isHistory || isBase3 || isAdmin || isManualExit);
  elements.historyPanel.classList.toggle("hidden", !isHistory);
  elements.base3Panel?.classList.toggle("hidden", !isBase3);
  elements.adminPanel.classList.toggle("hidden", !isAdmin);
  elements.manualExitPanel?.classList.toggle("hidden", !isManualExit);
  elements.registerTabButton.classList.toggle("active", !isHistory && !isBase3 && !isAdmin && !isManualExit);
  elements.historyTabButton.classList.toggle("active", isHistory);
  elements.base3TabButton?.classList.toggle("active", isBase3);
  elements.adminTabButton.classList.toggle("active", isAdmin);
  elements.manualExitTabButton?.classList.toggle("active", isManualExit);

  if (isManualExit) {
    syncServerClock().then(setupManualDefaults);
    manualAutoLocation();
  }

  if (isHistory) {
    setupHistoryDefaults();
    // Al entrar, si no hay cedula, mostramos los ultimos 20 registros (solo admin,
    // para no exponer datos de todos a un usuario no administrador).
    if (!normalizeDni(elements.historyDniInput.value)) {
      if (state.isAdmin) loadRecentHistory();
      else clearHistoryPanel();
    }
  }

  if (isBase3) {
    setupBase3Defaults();
    if (!state.base3Loaded) cargarBase3();
  }

  if (isAdmin) {
    showAdminSubtab(state.adminSubtab || "alerts");
    syncServerClock().then(setupManualDefaults);
    loadVehicles();
    loadAdminMarks();
    loadOpenTurns();
    loadSentidoRevisionMarks();
  }

  const isRegister = !isHistory && !isBase3 && !isAdmin && !isManualExit;
  if (isRegister) maybeShowTutorial();
}

function normalizeDni(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

function isDriverCargo(cargo) {
  return /\bconductor\b|operador|motorista/.test(String(cargo || "").toLowerCase());
}

function isDriverCollaborator(csvCollaborator) {
  return isDriverCargo(csvCollaborator?.cargo);
}

function requiresBiometric() {
  return state.isDriverCandidate;
}

function configureDriverFields(csvCollaborator) {
  const isDriver = isDriverCollaborator(csvCollaborator);
  state.isDriverCandidate = isDriver;
  elements.driverFields.classList.toggle("hidden", !isDriver);

  if (!isDriver) {
    elements.vehicleInput.value = "";
    elements.baseInput.value = "";
    elements.attendanceDriverBox.className = "result-box muted";
    elements.attendanceDriverBox.textContent = "Al validar la cedula del conductor se consultara Sonar y se preparara el vehiculo para la asignacion.";
    elements.locationStatus.textContent = "Pendiente por validar coordenadas.";
    return;
  }

  loadVehicles();
  elements.vehicleInput.value = "";
  elements.baseInput.value = "";
  updateVehicleHint();
  elements.attendanceDriverBox.className = "result-box muted";
  elements.attendanceDriverBox.textContent = "Selecciona el vehiculo y digita la base operativa antes de tomar la foto.";
  elements.locationStatus.textContent = "Pendiente por validar coordenadas.";
}

async function loadVehicles() {
  if (state.vehiclesLoaded) return state.vehicles;

  elements.vehicleInput.innerHTML = `<option value="">Cargando vehiculos...</option>`;
  if (elements.sonarVehicleSelect) {
    elements.sonarVehicleSelect.innerHTML = `<option value="">Cargando vehiculos...</option>`;
  }
  const { data, error } = await supabaseClient
    .from("vehiculossonar")
    .select("INTERNO,Placa,ID")
    .order("INTERNO", { ascending: true });

  if (error) {
    elements.vehicleInput.innerHTML = `<option value="">No se pudieron cargar vehiculos</option>`;
    if (elements.sonarVehicleSelect) {
      elements.sonarVehicleSelect.innerHTML = `<option value="">No se pudieron cargar vehiculos</option>`;
    }
    return [];
  }

  state.vehicles = (data || []).map((item) => ({
    interno: String(item.INTERNO ?? "").trim(),
    placa: String(item.Placa ?? "").trim(),
    id: String(item.ID ?? "").trim()
  })).filter((item) => item.interno);
  state.vehiclesLoaded = true;

  renderVehicleOptions();
  return state.vehicles;
}

function renderVehicleOptions() {
  const datalist = document.getElementById("vehiclesDatalist");
  if (datalist) {
    datalist.innerHTML = state.vehicles.map((vehicle) => {
      const label = `Interno ${escapeHtml(vehicle.interno)}${vehicle.placa ? ` - Placa ${escapeHtml(vehicle.placa)}` : ""}`;
      return `<option value="${label}"></option>`;
    }).join("");
  }
  if (elements.sonarVehicleSelect) {
    elements.sonarVehicleSelect.innerHTML = `
      <option value="">Selecciona interno</option>
      ${state.vehicles.map((vehicle) => `
        <option value="${escapeHtml(vehicle.id)}" data-placa="${escapeHtml(vehicle.placa)}" data-interno="${escapeHtml(vehicle.interno)}">
          ${escapeHtml(vehicle.interno)}${vehicle.placa ? ` - ${escapeHtml(vehicle.placa)}` : ""}
        </option>
      `).join("")}
    `;
  }
  updateVehicleHint();
}

function findVehicleFromInput(value) {
  const clean = String(value || "").trim().toUpperCase();
  if (!clean) return null;
  const normalizedSearch = clean.replace(/[^\dA-Z]/g, "");
  // Coincidencia por token con limites, para que un interno corto (ej. "1")
  // no se confunda dentro de "100" o de una placa como "ABC123".
  const contieneToken = (token) => {
    if (!token) return false;
    const t = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\dA-Z])${t}([^\\dA-Z]|$)`).test(clean);
  };
  return state.vehicles.find((v) => {
    const interno = (v.interno || "").toUpperCase();
    const placa = (v.placa || "").toUpperCase();
    const internoNorm = interno.replace(/[^\dA-Z]/g, "");
    const placaNorm = placa.replace(/[^\dA-Z]/g, "");
    return interno === clean
      || placa === clean
      || internoNorm === normalizedSearch
      || placaNorm === normalizedSearch
      || contieneToken(interno)
      || contieneToken(placa);
  }) || null;
}

function updateVehicleHint() {
  const hint = document.getElementById("vehicleHint");
  if (!hint) return;
  const vehicle = findVehicleFromInput(elements.vehicleInput.value);
  if (vehicle) {
    hint.textContent = `Vehiculo confirmado: Interno ${vehicle.interno}${vehicle.placa ? " - Placa " + vehicle.placa : ""}`;
    hint.style.color = "var(--primary)";
    hint.style.fontWeight = "700";
    elements.vehicleInput.classList.remove("invalid");
  } else if (elements.vehicleInput.value.trim()) {
    hint.textContent = "No encontramos ese vehiculo. Revisa interno o placa.";
    hint.style.color = "#b00020";
    hint.style.fontWeight = "700";
    elements.vehicleInput.classList.add("invalid");
  } else if (state.csvCandidate && !turnoProgramadoActual()) {
    // Sin programacion del dia no hay vehiculo asignado que exigir: se avisa que
    // el campo es opcional para que no parezca que falta llenarlo.
    hint.textContent = "Sin turno programado hoy: el vehículo es opcional, déjalo vacío si no lo sabes.";
    hint.style.color = "";
    hint.style.fontWeight = "";
    elements.vehicleInput.classList.remove("invalid");
  } else {
    hint.textContent = "Selecciona el interno asignado para hoy.";
    hint.style.color = "";
    hint.style.fontWeight = "";
    elements.vehicleInput.classList.remove("invalid");
  }
}

function selectVehicleFromCsv(value) {
  const clean = String(value || "").replace(/[^\dA-Za-z]/g, "").toUpperCase();
  if (!clean) return;

  const vehicle = state.vehicles.find((item) =>
    item.interno.replace(/[^\dA-Za-z]/g, "").toUpperCase() === clean
    || item.placa.replace(/[^\dA-Za-z]/g, "").toUpperCase() === clean
  );

  if (vehicle) {
    elements.vehicleInput.value = `Interno ${vehicle.interno}${vehicle.placa ? ` - Placa ${vehicle.placa}` : ""}`;
    updateVehicleHint();
  }
}

function getSelectedVehicleLabel() {
  const vehicle = findVehicleFromInput(elements.vehicleInput.value);
  if (!vehicle) return "";
  return `${vehicle.interno}${vehicle.placa ? ` - ${vehicle.placa}` : ""}`;
}

function getSelectedVehicle() {
  const vehicle = findVehicleFromInput(elements.vehicleInput.value);
  if (!vehicle) return null;
  return {
    interno: vehicle.interno || "",
    placa: vehicle.placa || "",
    m_id: vehicle.id || ""
  };
}

function renderAttendanceDriverBox(message = "") {
  if (!state.isDriverCandidate) return;

  const vehicle = getSelectedVehicle();
  const driver = state.attendanceSonarDriver;

  if (message) {
    elements.attendanceDriverBox.className = "result-box muted";
    elements.attendanceDriverBox.textContent = message;
    return;
  }

  elements.attendanceDriverBox.className = "result-box";
  elements.attendanceDriverBox.innerHTML = `
    <strong>Preparación de asignación</strong>
    <div>Conductor Sonar: ${escapeHtml(driver?.nombre || "No encontrado")}</div>
    <div>driverId: ${escapeHtml(driver?.dr_id || "Pendiente")}</div>
    <div>Vehículo Sonar: ${escapeHtml(vehicle?.interno || "Pendiente")}${vehicle?.placa ? ` - ${escapeHtml(vehicle.placa)}` : ""}</div>
    <div>mId: ${escapeHtml(vehicle?.m_id || "Pendiente")}</div>
  `;
}

async function prepareAttendanceDriverIntegration(csvCollaborator, dni) {
  if (!isDriverCollaborator(csvCollaborator)) {
    state.attendanceSonarDriver = null;
    return;
  }

  renderAttendanceDriverBox("Consultando conductor en Sonar...");
  await loadVehicles();
  state.attendanceSonarDriver = await findSonarDriverByDni(dni);
  renderAttendanceDriverBox();
}

/* ==========================================================================
   Programacion de turnos
   La programacion (programacion_filas) trae el horario del conductor pero no su
   cedula; el cruce nombre -> cedula lo resuelve la tabla programacion_conductor_dni
   y queda materializado en programacion_turnos. Aqui solo se consume.

   OJO con el criterio (calibrado contra 12.786 marcas reales):
     - INICIA   -> hora de entrada del conductor 1. Confiable (dispersion 15 min).
     - INICIA 2 -> hora de entrada del conductor 2. Es una HORA LIMITE, no la hora
                   de relevo: casi todos llegan antes.
     - HORA FIN -> hora de salida del conductor 2. Tambien hora limite.
     - La SALIDA del conductor 1 NO se puede evaluar: la programacion no registra
       la hora real del relevo.
   ========================================================================== */

const PUNTUALIDAD_TOLERANCIA_MIN = 15;

function limpiarProgramacion() {
  state.programacionHoy = null;
  state.programacionAvisoVehiculo = "";
  state.programacionAvisoHorario = "";
  state.motivoDesfase = "";
  state.motivoJornadaExtendida = "";
  state.novedadHoy = null;
  state.turnoEstado = null;
  elements.programacionBanner?.classList.add("hidden");
  hideDriverGreetingCard();
}

// True si la jornada del turno que corresponde a este momento YA se cumplio
// (tiene entrada y salida): no se debe permitir otra marca.
function jornadaYaCumplida() {
  return !!(state.turnoEstado?.existe && state.turnoEstado?.completa);
}

// Momento del reporte como timestamp ("YYYY-MM-DDTHH:MM:SS"). En produccion es la
// hora del servidor; en local puede estar editada para pruebas, y todo lo que se
// evalua (programacion, turno cumplido) debe seguir ESA fecha, no la de hoy.
function momentoReporte() {
  const p = getReportParts();
  if (!p?.date || !p?.time) return null;
  const t = p.time.length === 5 ? `${p.time}:00` : p.time;
  return `${p.date}T${t}`;
}

// Consulta si el turno de este momento ya esta cumplido. Se llama despues de
// cargar la programacion, porque de ahi sale el aviso y el bloqueo.
async function cargarEstadoTurno(dni) {
  state.turnoEstado = null;
  if (!dni) return;
  try {
    const { data, error } = await supabaseClient.rpc("estado_turno_actual", {
      p_dni: dni, p_momento: momentoReporte()
    });
    if (error) throw error;
    if (data?.ok) state.turnoEstado = data;
  } catch (e) {
    console.warn("No se pudo consultar el estado del turno:", e?.message || e);
  }
  renderProgramacionBanner();
}

// Devuelve el turno del dia que corresponde al sentido que se va a marcar.
function turnoProgramadoActual() {
  const turnos = state.programacionHoy?.turnos || [];
  if (!turnos.length) return null;
  if (turnos.length === 1) return turnos[0];
  // Con dos turnos el mismo dia gana el mas cercano a la hora que se va a registrar.
  const partes = getReportParts();
  const minutosMarca = Number(partes.time.slice(0, 2)) * 60 + Number(partes.time.slice(3, 5));
  const aMin = (hhmm) => {
    if (!hhmm) return null;
    return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  };
  let mejor = turnos[0];
  let mejorDist = Infinity;
  for (const t of turnos) {
    const ref = aMin(state.nextSentido === "salida" ? t.hora_salida : t.hora_entrada);
    if (ref === null) continue;
    const dist = Math.abs(minutosMarca - ref);
    if (dist < mejorDist) { mejorDist = dist; mejor = t; }
  }
  return mejor;
}

function minutosDesdeProgramado(horaProgramada) {
  if (!horaProgramada) return null;
  const partes = getReportParts();
  const marca = Number(partes.time.slice(0, 2)) * 60 + Number(partes.time.slice(3, 5));
  const prog = Number(horaProgramada.slice(0, 2)) * 60 + Number(horaProgramada.slice(3, 5));
  let dif = marca - prog;
  // La jornada del turno 2 cruza la medianoche: 23:50 vs 00:05 son 15 min, no 1425.
  if (dif > 720) dif -= 1440;
  if (dif < -720) dif += 1440;
  return dif;
}

// Cargos que por definicion NO llevan programacion de turnos. Se comparan por
// palabras clave porque en la base vienen con variantes de escritura
// ("GESTOR DE SERVICIO", "GESTOR DE SERVICIOS Y EMBARQUEOPERATIVO", etc.).
const CARGOS_SIN_PROGRAMACION = [
  { re: /gestor.*(servicio|embarque)/, etiqueta: "Gestor de servicios y embarque" },
  { re: /gestor.*movilidad/,           etiqueta: "Gestor de movilidad" },
  { re: /auxiliar.*(control|flota)/,   etiqueta: "Auxiliar de gestión y control de flota" },
  { re: /lider.*(control|servicio)/,   etiqueta: "Líder operativo" },
  { re: /auxiliar.*(administrativ|comunicacion)/, etiqueta: "Auxiliar administrativa" }
];

// Devuelve la etiqueta del cargo si es uno de los que no maneja programacion.
function cargoSinProgramacion(cargo) {
  const c = String(cargo || "").toLowerCase();
  if (!c) return null;
  return CARGOS_SIN_PROGRAMACION.find((x) => x.re.test(c))?.etiqueta || null;
}

function hhmmAMin(hhmm) {
  if (!hhmm) return null;
  const h = Number(String(hhmm).slice(0, 2));
  const m = Number(String(hhmm).slice(3, 5));
  return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : null;
}

// Barra visual del turno: entrada --- (ahora) --- salida.
function lineaDeTiempoTurno(turno) {
  const ent = hhmmAMin(turno.hora_entrada);
  let sal = hhmmAMin(turno.hora_salida);
  const partes = getReportParts();
  let ahora = hhmmAMin(partes.time);
  if (ent === null || sal === null || ahora === null) return "";

  // El turno 2 cruza la medianoche: se estira la escala en vez de dar vuelta atras.
  if (sal <= ent) sal += 1440;
  if (ahora < ent - 180) ahora += 1440;

  const span = sal - ent;
  const pct = span > 0 ? Math.max(0, Math.min(100, ((ahora - ent) / span) * 100)) : 0;
  const dentro = ahora >= ent && ahora <= sal;

  return `
    <div class="prog-linea">
      <div class="prog-linea-barra">
        <div class="prog-linea-progreso" style="width:${pct.toFixed(1)}%"></div>
        <div class="prog-linea-ahora ${dentro ? "" : "fuera"}" style="left:${pct.toFixed(1)}%"
             title="Hora actual"></div>
      </div>
      <div class="prog-linea-extremos">
        <span><small>Entrada</small><strong>${escapeHtml(turno.hora_entrada || "--:--")}</strong></span>
        <span class="prog-ahora-txt">ahora ${escapeHtml(partes.time.slice(0, 5))}</span>
        <span class="der"><small>Salida</small><strong>${escapeHtml(turno.hora_salida || "--:--")}</strong></span>
      </div>
    </div>`;
}

// Anuncio grande y automatico de lo que se va a registrar. Es lo primero que debe
// ver quien marca, ANTES de tomar la foto: si dice ENTRADA y venia a salir, ahi se
// atrapa el error, que es justo lo que producia los sentidos invertidos.
function anuncioSentidoHtml(sentido, turno) {
  const esEntrada = sentido !== "salida";
  const horaProg = turno ? (esEntrada ? turno.hora_entrada : turno.hora_salida) : null;
  const detalle = turno
    ? `Turno ${turno.turno} · ${esEntrada ? "entrada" : "salida"} programada
       <strong>${escapeHtml(horaProg || "--:--")}</strong>`
    : "Según su última marca registrada";
  return `
    <div class="prog-anuncio ${esEntrada ? "es-entrada" : "es-salida"}">
      <i data-lucide="${esEntrada ? "log-in" : "log-out"}"></i>
      <div>
        <strong>Va a registrar ${esEntrada ? "ENTRADA" : "SALIDA"}</strong>
        <small>${detalle}</small>
      </div>
    </div>`;
}

function renderProgramacionBanner() {
  const banner = elements.programacionBanner;
  if (!banner) return;

  // Sin colaborador validado no hay nada que mostrar.
  if (!state.csvCandidate && !state.colaborador) {
    banner.classList.add("hidden");
    banner.innerHTML = "";
    return;
  }

  // ---- Turno anterior sin cerrar: no se admite la ENTRADA hasta declararlo ----
  // Va antes que todo lo demas porque es un bloqueo, no un aviso: mientras el turno
  // viejo siga abierto, cualquier entrada nueva deja la salida perdida para siempre.
  if (state.cierrePendiente && state.openEntrada) {
    const c = state.cierrePendiente;
    banner.className = "programacion-banner bloqueado";
    banner.innerHTML = `
      <div class="programacion-titulo">
        <i data-lucide="lock"></i>
        Falta cerrar el turno del ${escapeHtml(c.fecha)}
        <span class="prog-chip bloqueo">Entrada bloqueada</span>
      </div>
      <div class="prog-cumplida">
        <span><small>Entrada abierta</small><strong>${escapeHtml(c.hora || "--:--")}</strong>
          <em>${escapeHtml(c.fecha)}</em></span>
        <span><small>Salida sugerida</small><strong>${escapeHtml(c.horaProg || "--:--")}</strong>
          <em>${c.horaProg ? "por confirmar" : "hay que preguntarla"}</em></span>
        <span><small>Salida real</small><strong>—</strong>
          <em>sin registrar</em></span>
      </div>
      <div class="programacion-estado">
        Esta persona <strong>entró y nunca marcó la salida</strong>. Hasta que ese turno no
        quede cerrado <strong>no se puede registrar la entrada de hoy</strong>: quedarían dos
        turnos abiertos y la salida pendiente se perdería.
      </div>
      <button id="cierrePendienteButton" class="primary wide" type="button">
        <i data-lucide="clock"></i>
        Declarar la hora de salida y cerrar
      </button>`;
    banner.classList.remove("hidden");
    if (window.lucide?.createIcons) window.lucide.createIcons();
    return;
  }

  // ---- Jornada del turno YA cumplida: se bloquea otra marca ----
  if (jornadaYaCumplida()) {
    const t = state.turnoEstado;
    banner.className = "programacion-banner bloqueado";
    banner.innerHTML = `
      <div class="programacion-titulo">
        <i data-lucide="shield-check"></i>
        Jornada de hoy ya cumplida
        <span class="prog-chip bloqueo">No admite más marcas</span>
      </div>
      <div class="prog-cumplida">
        <span><small>Entrada</small><strong>${escapeHtml(t.entrada_real || "--:--")}</strong>
          <em>prog ${escapeHtml(t.entrada_prog || "--:--")}</em></span>
        <span><small>Salida</small><strong>${escapeHtml(t.salida_real || "--:--")}</strong>
          <em>prog ${escapeHtml(t.salida_prog || "--:--")}</em></span>
        <span><small>Turno</small><strong>${t.turno ?? "—"}</strong>
          <em>${escapeHtml(t.vehiculo || "")}</em></span>
      </div>
      <div class="programacion-estado">
        Este conductor <strong>ya registró la entrada y la salida</strong> de su turno programado,
        así que su jornada está cerrada y <strong>no se permite otra marca</strong>.
        <br>Si hay algo que corregir, hazlo en
        <strong>Administración › Verificador de horarios</strong>.
      </div>`;
    banner.classList.remove("hidden");
    if (window.lucide?.createIcons) window.lucide.createIcons();
    return;
  }

  const turno = turnoProgramadoActual();

  // ---- Sin programacion: se explica POR QUE, segun el cargo ----
  if (!turno) {
    const cargo = state.csvCandidate?.cargo || "";
    const etiqueta = cargoSinProgramacion(cargo);
    const esConductor = isDriverCargo(cargo);

    const anuncio = anuncioSentidoHtml(state.nextSentido || "entrada", null);

    // La tabla `novedades` es la otra cara de la programacion: si no hay turno,
    // muchas veces si hay una razon escrita (DESCANSO, VACACIONES, INCAPACITADO...).
    // Decirla es mejor que un "sin programacion" que no explica nada.
    const nov = state.programacionHoy?.novedad || state.novedadHoy;
    if (nov?.existe) {
      const bloquea = !!nov.bloquea;
      banner.className = `programacion-banner ${bloquea ? "tarde" : "info"}`;
      banner.innerHTML = `
        ${anuncio}
        <div class="programacion-titulo">
          <i data-lucide="${bloquea ? "alert-octagon" : "calendar-off"}"></i>
          Hoy figura en <strong>${escapeHtml(nov.estado)}</strong>
          <span class="prog-chip ${bloquea ? "tarde" : "neutro"}">${bloquea ? "No debería marcar" : "Sin turno"}</span>
        </div>
        <div class="programacion-estado">
          ${bloquea
            ? `La programación lo tiene en <strong>${escapeHtml(nov.estado)}</strong>
               (${escapeHtml(nov.base || "sin base")}), que <strong>no es compatible con estar
               laborando</strong>. Confirma con administración antes de registrar: si la marca
               igual va, quedará señalada.`
            : `Por eso no tiene turno asignado hoy: la programación lo reporta en
               <strong>${escapeHtml(nov.estado)}</strong> (${escapeHtml(nov.base || "sin base")}).
               Si vino a cubrir un turno, puedes registrar la marca; queda visible en
               Administración.`}
          <br>El tipo de marca se define por la última registrada:
          <strong>revísalo abajo</strong> antes de guardar.
        </div>`;
      banner.classList.remove("hidden");
      if (window.lucide?.createIcons) window.lucide.createIcons();
      return;
    }

    if (esConductor) {
      // Un conductor SIEMPRE deberia tener turno: esto es una alerta real.
      banner.className = "programacion-banner tarde";
      banner.innerHTML = `
        ${anuncio}
        <div class="programacion-titulo">
          <i data-lucide="alert-triangle"></i>
          Conductor sin turno programado hoy
        </div>
        <div class="programacion-estado">
          Este conductor <strong>no aparece en la programación de hoy</strong>. Puede que la
          programación no se haya cargado o que su nombre no esté cruzado.
          <br><strong>Avisa a administración</strong> antes de registrar. Mientras tanto, el tipo
          de marca se define por la última marca: <strong>verifícalo abajo</strong> antes de guardar.
        </div>`;
    } else {
      banner.className = "programacion-banner info";
      banner.innerHTML = `
        ${anuncio}
        <div class="programacion-titulo">
          <i data-lucide="info"></i>
          Sin turno programado ${etiqueta ? `· ${escapeHtml(etiqueta)}` : ""}
        </div>
        <div class="programacion-estado">
          ${etiqueta
            ? `Los cargos de <strong>${escapeHtml(etiqueta)}</strong> no manejan programación de turnos,
               así que no hay horario contra el cual comparar.`
            : `Este cargo no tiene programación de turnos cargada.`}
          El tipo de marca (entrada/salida) se define por la última marca registrada:
          <strong>revísalo abajo</strong> y corrígelo si no corresponde.
        </div>`;
    }
    banner.classList.remove("hidden");
    if (window.lucide?.createIcons) window.lucide.createIcons();
    return;
  }

  // ---- Con programacion: se muestra el turno y como va frente a el ----
  const sentido = state.nextSentido || "entrada";
  const horaRef = sentido === "salida" ? turno.hora_salida : turno.hora_entrada;
  const dif = minutosDesdeProgramado(horaRef);
  const evaluable = !(sentido === "salida" && turno.turno === 1);

  let estado = "";
  let insignia = "";
  let clase = "programacion-banner";
  if (horaRef && dif !== null && evaluable) {
    // "Antes" en la entrada y "después" en la salida son lo habitual: no se pintan
    // como falta. Solo se resalta lo que de verdad se sale del comportamiento normal.
    const fuera = excedeUmbralHorario(sentido, dif);
    if (fuera && esCambioDeTurno(sentido, dif)) {
      // Un desfase de horas en la entrada no es impuntualidad: es otro turno.
      const horasDif = Math.round((Math.abs(dif) / 60) * 10) / 10;
      clase += " tarde";
      insignia = `<span class="prog-chip tarde">Cambio de turno</span>`;
      estado = `Su turno de hoy es el <strong>${turno.turno}</strong> `
             + `(${escapeHtml(horaRef)}), pero está entrando <strong>${horasDif} h `
             + `${dif > 0 ? "después" : "antes"}</strong>. Se puede registrar, pero al guardar `
             + `<strong>hay que explicar por qué entra a esta hora</strong>.`;
    } else if (fuera) {
      clase += " tarde";
      insignia = `<span class="prog-chip tarde">${Math.abs(dif)} min ${dif > 0 ? "después" : "antes"}</span>`;
      estado = `Está marcando <strong>${Math.abs(dif)} min ${dif > 0 ? "después" : "antes"}</strong> `
             + `de su hora programada (${escapeHtml(horaRef)}), fuera de lo habitual.`;
    } else if (Math.abs(dif) <= PUNTUALIDAD_TOLERANCIA_MIN) {
      clase += " ok";
      insignia = `<span class="prog-chip ok">A tiempo</span>`;
      estado = `Va <strong>a tiempo</strong> frente a su hora programada (${escapeHtml(horaRef)}).`;
    } else {
      clase += " ok";
      insignia = `<span class="prog-chip ok">${Math.abs(dif)} min ${dif > 0 ? "después" : "antes"}</span>`;
      estado = `Va <strong>${Math.abs(dif)} min ${dif > 0 ? "después" : "antes"}</strong> `
             + `de las ${escapeHtml(horaRef)}, dentro de lo habitual.`;
    }
  } else if (!evaluable) {
    insignia = `<span class="prog-chip neutro">No evaluable</span>`;
    estado = "La salida del turno 1 no se compara: la programación no registra la hora de relevo.";
  }

  // Invitacion a corregir solo cuando el desfase se sale de lo habitual. En un cambio
  // de turno el sentido SI corresponde, asi que invitar a cambiarlo seria un error:
  // lo que se pide ahi es la explicacion.
  const aviso = !(evaluable && excedeUmbralHorario(sentido, dif))
    ? ""
    : esCambioDeTurno(sentido, dif)
      ? `<div class="programacion-aviso">
           <i data-lucide="repeat"></i>
           Parece un <strong>cambio de turno</strong>. La marca se registra igual; al guardar se
           pedirá el motivo para que quede escrito quién autorizó el cambio.
         </div>`
      : `<div class="programacion-aviso">
           <i data-lucide="help-circle"></i>
           Hay <strong>${Math.abs(dif)} min</strong> de diferencia con lo programado. Si el tipo de
           marca no corresponde, <strong>corrígelo abajo</strong> antes de registrar.
         </div>`;

  banner.className = clase;
  banner.innerHTML = `
    ${anuncioSentidoHtml(sentido, turno)}
    <div class="programacion-titulo">
      <i data-lucide="calendar-clock"></i>
      Turno ${turno.turno} programado hoy
      ${insignia}
    </div>
    ${lineaDeTiempoTurno(turno)}
    <div class="programacion-horas">
      ${turno.vehiculo ? `<span>Vehículo <strong>${escapeHtml(turno.vehiculo)}</strong></span>` : ""}
      ${turno.base ? `<span>${escapeHtml(turno.base)}</span>` : ""}
      ${turno.puesto ? `<span>${escapeHtml(turno.puesto)}</span>` : ""}
    </div>
    ${estado ? `<div class="programacion-estado">${estado}</div>` : ""}
    ${aviso}
  `;
  banner.classList.remove("hidden");
  if (window.lucide?.createIcons) window.lucide.createIcons();
}

async function cargarProgramacionDia(dni) {
  limpiarProgramacion();
  if (!dni) return;

  try {
    const { data, error } = await supabaseClient.rpc("obtener_programacion_dia", {
      p_dni: dni,
      p_fecha: getReportParts().date
    });
    if (error) throw error;

    if (data?.ok && data.existe) {
      state.programacionHoy = data;
      autocompletarDesdeProgramacion();
    }
    // Sin turno, la razon suele estar en `novedades` (DESCANSO, VACACIONES...).
    // Se guarda aparte porque programacionHoy solo se llena cuando SI hay turno.
    state.novedadHoy = (data?.ok && data.novedad?.existe) ? data.novedad : null;
    // Se pinta siempre: sin programacion el aviso explica POR QUE no la hay
    // (gestores, auxiliares...) o alerta si es un conductor, que si deberia tenerla.
    renderProgramacionBanner();
  } catch (e) {
    console.warn("No se pudo consultar la programacion del dia:", e?.message || e);
    renderProgramacionBanner();
  }
}

// Llena vehiculo y base con lo programado, sin pisar lo que ya escribio el usuario.
function autocompletarDesdeProgramacion() {
  const turno = turnoProgramadoActual();
  if (!turno || !state.isDriverCandidate) return;

  if (turno.vehiculo && !elements.vehicleInput.value.trim()) {
    selectVehicleFromCsv(turno.vehiculo);
  }
  if (turno.base && !elements.baseInput.value.trim()) {
    elements.baseInput.value = turno.base;
  }
}

// Aviso si el vehiculo seleccionado no es el programado. No bloquea: la operacion
// cambia de vehiculo a diario y la programacion puede quedar desactualizada.
async function confirmarVehiculoProgramado() {
  const turno = turnoProgramadoActual();
  const programado = String(turno?.vehiculo || "").trim();
  if (!programado) return true;

  const seleccionado = getSelectedVehicle();
  const interno = String(seleccionado?.interno || "").trim();
  if (!interno) return true;

  const iguales = interno.replace(/[^\dA-Za-z]/g, "").toUpperCase()
                === programado.replace(/[^\dA-Za-z]/g, "").toUpperCase();
  if (iguales) return true;

  // Solo se pregunta una vez por combinacion, para no repetir el modal.
  const clave = `${interno}|${programado}`;
  if (state.programacionAvisoVehiculo === clave) return true;
  state.programacionAvisoVehiculo = clave;

  // confirmGraphical usa textContent: aqui va texto plano, no HTML.
  return confirmGraphical(
    "Vehículo distinto al programado",
    `La programación de hoy asigna el vehículo ${programado} a este conductor, `
    + `pero seleccionaste el ${interno}. ¿Deseas registrar la marca así?`,
    "Sí, registrar",
    "Corregir vehículo"
  );
}

// Umbrales (min) para ALERTAR cuando la hora marcada no concuerda con la programada.
// Son ASIMETRICOS porque el comportamiento real lo es: medido sobre 5.488 marcas
// (jul-ago 2026) contra su turno programado:
//   ENTRADA  mediana -17 min  (entrar temprano es lo normal; 18% entra >1 h antes)
//   SALIDA   mediana +28 min  (cerrar tarde es lo normal; 36% cierra >1 h tarde,
//                              26% >1,5 h y 12% >2,5 h)
// Con un umbral unico de 60 min se alertaria el 36% de las salidas: puro ruido, y el
// operador termina ignorando el aviso. Con estos, la alerta cae en ~2-3,5% de los
// casos en cada escenario, que es donde de verdad hay algo raro que mirar.
const ALERTA_HORARIO = {
  entrada: { tarde: 60,  antes: 180 },  // alerta 3,5% / 1,9%
  salida:  { tarde: 240, antes: 180 }   // alerta 3,0% / 2,5%
};

// True si el desfase se sale de lo habitual para ese sentido.
function excedeUmbralHorario(sentido, dif) {
  if (dif === null || dif === undefined) return false;
  const u = ALERTA_HORARIO[sentido === "salida" ? "salida" : "entrada"];
  return dif > 0 ? dif > u.tarde : Math.abs(dif) > u.antes;
}

// Aviso si la hora de la marca no concuerda con el horario programado del turno.
// No bloquea: la operacion cambia y la programacion puede quedar desactualizada,
// pero deja constancia visible a quien registra para que revise antes de guardar.
/* --------------------------------------------------------------------------
   Cambio de turno: el conductor entra a una hora que NO es la suya.

   Caso real (ARRIAGA PEREA VICTOR WILMAN, 13-ago-2026): programado turno 2 de
   15:45 a 00:45, se presento a las 05:48 -- 597 min antes -- porque cambio el
   turno con un companero que tenia cita medica. Pasa a diario en la operacion,
   pero deja una marca que no cuadra con nada y que nadie sabe explicar despues.

   Solo aplica a CONDUCTORES: son los unicos con turno programado contra el cual
   se pueda decir que la hora "no es la suya".
   -------------------------------------------------------------------------- */

const MOTIVOS_CAMBIO_TURNO = [
  "Cambio de turno con un compañero",
  "Cubriendo el turno de otro conductor",
  "Cambió el turno por cita médica",
  "Le pidieron adelantar el turno",
  "Novedad del conductor programado",
  "Le pidieron cubrir un turno adicional"
];

// True si la ENTRADA cae tan lejos de su turno programado que no es su horario.
// Se usa el mismo margen con el que la app decide el sentido por programacion.
function esCambioDeTurno(sentido, dif) {
  if (sentido !== "entrada") return false;
  if (!state.isDriverCandidate) return false;   // solo conductores
  if (state.turnoEstado?.cambio_turno) return true;
  return dif !== null && Math.abs(dif) > SENTIDO_PROG_MAX_MIN;
}

async function confirmarHorarioProgramado(sentido) {
  const turno = turnoProgramadoActual();
  if (!turno) return true; // sin programacion del dia: no hay contra que comparar

  // La salida del turno 1 no tiene hora de relevo registrada: no se evalua.
  if (sentido === "salida" && turno.turno === 1) return true;

  const horaRef = sentido === "salida" ? turno.hora_salida : turno.hora_entrada;
  const dif = minutosDesdeProgramado(horaRef);
  if (!horaRef || dif === null) return true;
  if (!excedeUmbralHorario(sentido, dif)) return true; // dentro de lo habitual

  const horaMarca = getReportParts().time.slice(0, 5);
  const etiqueta = sentido === "salida" ? "SALIDA" : "ENTRADA";
  const desfase = dif > 0 ? `${dif} min después` : `${Math.abs(dif)} min antes`;

  // Solo se pregunta una vez por combinacion, para no repetir el modal.
  const clave = `${sentido}|${horaRef}|${horaMarca}`;
  if (state.programacionAvisoHorario === clave) return true;
  state.programacionAvisoHorario = clave;

  // Un desfase de 10 h no es "llegó tarde": es otro turno. Se pregunta como lo que
  // es, con los motivos del caso, para no forzar a escribirlo a mano cada vez.
  const cambio = esCambioDeTurno(sentido, dif);
  if (cambio) {
    const horas = Math.round((Math.abs(dif) / 60) * 10) / 10;
    const motivo = await pedirMotivoDesfase(
      "Esta entrando en un turno que no es el suyo",
      `Su turno programado de hoy es el ${turno.turno} (${horaRef}`
      + `${turno.hora_salida ? ` a ${turno.hora_salida}` : ""}), pero está marcando ENTRADA `
      + `a las ${horaMarca}: ${horas} h ${dif > 0 ? "después" : "antes"}. `
      + "Se puede registrar —los cambios de turno son normales—, pero hay que dejar "
      + "escrito por qué entra a esta hora.",
      MOTIVOS_CAMBIO_TURNO
    );
    if (motivo === null) return false;
    state.motivoDesfase =
      `CAMBIO DE TURNO: ENTRADA ${horaMarca} vs su turno ${turno.turno} de las ${horaRef} `
      + `(${desfase}): ${motivo}`;
    return true;
  }

  // En vez de un si/no suelto se pide el MOTIVO: asi la novedad queda explicada
  // en la marca (p.ej. "estaba en el taller") y no como un desfase sin razon.
  const motivo = await pedirMotivoDesfase(
    "¿Por qué no coincide con el horario?",
    `El horario programado de ${etiqueta.toLowerCase()} es ${horaRef}, pero se está marcando `
    + `${etiqueta} a las ${horaMarca} (${desfase} de lo programado). `
    + "Escribe el motivo para poder registrar la marca."
  );
  if (motivo === null) return false;   // canceló: revisa la hora

  state.motivoDesfase = `${etiqueta} ${horaMarca} vs programada ${horaRef} (${desfase}): ${motivo}`;
  return true;
}

/* --------------------------------------------------------------------------
   El HORARIO decide si la persona esta llegando o saliendo
   Antes el sentido salia solo de "hay una entrada abierta", asi que un turno sin
   cerrar convertia la LLEGADA del dia siguiente en una SALIDA (sentido invertido)
   y el error se arrastraba en cascada. La programacion sabe cual de las dos es.
   -------------------------------------------------------------------------- */

// Si la marca queda a mas de esto de cualquier hora programada, el horario no es
// una referencia confiable y se vuelve a la logica por ultima marca.
const SENTIDO_PROG_MAX_MIN = 180;

// Devuelve { sentido, dist, minutos, turno } segun la hora programada mas cercana,
// o null si no hay programacion del dia.
function sentidoSugeridoPorProgramacion() {
  const turnos = state.programacionHoy?.turnos || [];
  if (!turnos.length) return null;

  let mejor = null;
  for (const t of turnos) {
    const refs = [["entrada", t.hora_entrada], ["salida", t.hora_salida]];
    for (const [sentido, hora] of refs) {
      if (!hora) continue;
      const dif = minutosDesdeProgramado(hora);
      if (dif === null) continue;
      const dist = Math.abs(dif);
      if (!mejor || dist < mejor.dist) mejor = { sentido, dist, minutos: dif, turno: t };
    }
  }
  return mejor;
}

// Motivos frecuentes por los que una salida no quedo registrada el dia que era.
// Son otros que los de MOTIVOS_DESFASE: alli la marca existe pero a destiempo; aqui
// la marca nunca se hizo, que es la brecha que hay que cerrar.
const MOTIVOS_SIN_CIERRE = [
  "Se le olvidó marcar la salida",
  "Terminó fuera de la base",
  "Entregó el vehículo en el taller",
  "No había quien le registrara",
  "Falla de la aplicación o del equipo",
  "Terminó después del cierre del punto"
];

/* --------------------------------------------------------------------------
   Jornadas que superan el maximo de horas que acepta Buk.

   Es el rechazo #1 de Buk ("Las marcas excedieron el máximo de horas permitidas
   por jornada"): 190 veces entre el 1-jun y el 12-ago-2026. La marca queda en
   nuestra base pero NO entra a nomina.

   El limite sale de los datos, no de una corazonada. Sobre 9.603 jornadas:
   por debajo de 16 h el rechazo es del 0,1-3,8 %; entre 16 y 17 h fueron 26 de
   26, o sea el 100 %. El corte es exacto en 16 h.
   -------------------------------------------------------------------------- */

const LIMITE_HORAS_JORNADA = 16;

// Tope duro del dialogo de cierre. No es el limite de Buk (16 h): una jornada puede
// quedarse abierta y cerrarse legitimamente mas tarde. Pero pasado el doble del maximo
// casi siempre es un error de digitacion, asi que ahi si se para y se pregunta.
const CIERRE_HORAS_MAX = 20;

const MOTIVOS_JORNADA_EXTENDIDA = [
  "El relevo no llegó y le tocó seguir",
  "Vehículo varado, esperó el auxilio",
  "Se le olvidó marcar la salida el día anterior",
  "Apoyo a otro turno por falta de personal",
  "Novedad en vía que alargó el recorrido",
  "Error en la hora de la marca de entrada"
];

// Horas que llevaria la jornada si se cierra en el momento del reporte.
function horasJornadaAbierta() {
  const open = state.openEntrada;
  if (!open?.fecha || !open?.hora) return null;
  const p = getReportParts();
  if (!p?.date || !p?.time) return null;

  const ini = new Date(`${open.fecha}T${String(open.hora).slice(0, 8)}`);
  const fin = new Date(`${p.date}T${p.time.length === 5 ? p.time + ":00" : p.time}`);
  if (isNaN(ini) || isNaN(fin)) return null;
  return Math.round(((fin - ini) / 3600000) * 10) / 10;
}

// Si la salida va a cerrar una jornada de mas de 16 h, se EXIGE la explicacion.
// No es un aviso que se pueda saltar: Buk va a rechazar la marca y alguien tiene
// que responder por que paso. Devuelve true si se puede continuar.
async function confirmarJornadaExtendida(sentido) {
  state.motivoJornadaExtendida = "";
  if (sentido !== "salida") return true;

  const horas = horasJornadaAbierta();
  if (horas === null || horas <= LIMITE_HORAS_JORNADA) return true;

  const open = state.openEntrada;
  const motivo = await pedirMotivoDesfase(
    `Jornada de ${horas} h: pasa del máximo`,
    `La entrada fue el ${open.fecha} a las ${String(open.hora).slice(0, 5)}, así que esta salida `
    + `cierra una jornada de ${horas} h — ${Math.round((horas - LIMITE_HORAS_JORNADA) * 10) / 10} h `
    + `por encima del máximo de ${LIMITE_HORAS_JORNADA} h que acepta Buk. `
    + "La marca se va a guardar, pero Buk la va a rechazar y no entrará a nómina. "
    + "Explica qué pasó: queda como novedad a tu nombre para que administración la revise.",
    MOTIVOS_JORNADA_EXTENDIDA
  );
  if (motivo === null) return false;

  state.motivoJornadaExtendida = motivo;
  state.horasJornadaExtendida = horas;
  return true;
}

// Guarda la explicacion en la novedad que creo el trigger de la base. Si la jornada
// no supero el limite, la funcion responde aplica=false y no pasa nada.
async function explicarJornadaExcedida(salidaId, motivo) {
  if (!salidaId || !motivo) return;
  try {
    await supabaseClient.rpc("explicar_jornada_excedida", {
      p_salida_id: salidaId, p_motivo: motivo
    });
  } catch (e) {
    // La novedad ya existe sin explicacion: se vera como "sin explicar" en
    // Administracion, que es justamente lo que no queremos perder.
    console.warn("No se pudo guardar la explicacion de la jornada extendida:", e?.message || e);
  }
}

// Hora de salida que se le propone al operario, con su procedencia.
//
// Antes se cogia el turno programado "mas cercano" a la entrada, sin limite de
// distancia: para una entrada de las 15:38 se tomaba un turno que empieza a las 05:00
// -a 638 minutos- y se proponia su salida de las 13:00, o sea una jornada de 22,4 h.
// La funcion de la base solo acepta un turno a menos de 3 h de la marca real y, si no
// lo hay, mira lo que esa persona hace de verdad cuando entra a esa hora.
async function sugerenciaCierre(entradaId) {
  if (!entradaId) return null;
  try {
    const { data, error } = await supabaseClient.rpc("sugerencia_cierre_turno", {
      p_entrada_id: entradaId
    });
    if (error || !data?.ok) return null;
    return data;
  } catch {
    return null;
  }
}

function horaAMinutos(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Suma dias a una fecha 'YYYY-MM-DD' sin pasar por la zona horaria del equipo.
function sumarDiasIso(iso, dias) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// Duracion del turno si se declara `hora` como salida, contando que puede cruzar la
// medianoche (igual que lo resuelve cerrar_turno_automatico en la base).
function horasDeJornada(horaEntrada, horaSalida) {
  const a = horaAMinutos(horaEntrada);
  const b = horaAMinutos(horaSalida);
  if (a === null || b === null) return null;
  const diff = b <= a ? b + 1440 - a : b - a;
  return Math.round((diff / 60) * 10) / 10;
}

// Pide al operario que DECLARE la hora real de salida y el motivo por el que no quedo
// registrada. Devuelve {hora, motivo} o null si prefiere registrar la salida ahora.
function pedirCierreTurno({ open, horaAbierta, sugerencia, horaTurnoHoy, nombre }) {
  return new Promise((resolve) => {
    const ov = elements.cierreOverlay;
    if (!ov) { resolve(null); return; }

    // Se propone la hora programada solo si el turno de verdad corresponde a esta
    // entrada; si no, lo que esa persona hace cuando entra a esa hora. Y si no hay
    // ninguna de las dos, el campo queda VACIO: mejor preguntar que inventar.
    const prog = sugerencia?.programada || null;
    const hab = sugerencia?.habitual || null;
    const horaProg = prog?.hora || "";
    const propuesta = horaProg || hab?.hora || "";

    elements.cierreTitle.textContent = "Falta cerrar un turno";
    elements.cierreText.textContent =
      `${nombre || "Esta persona"} marcó ENTRADA el ${open.fecha} a las ${horaAbierta} `
      + "y nunca registró la salida. "
      + (horaTurnoHoy
          ? `Según la programación, ahora está llegando a su turno de las ${horaTurnoHoy}. `
          : "")
      + "Ese turno tiene que quedar cerrado antes de registrar la entrada de hoy.";

    elements.cierreHoraInput.value = propuesta;
    elements.cierreHoraHint.textContent = prog
      ? `Se propone la salida programada de su turno ${prog.turno} (${prog.hora}). `
        + "Corrígela si terminó a otra hora."
      : hab
        ? `Ese turno no tiene hora programada. Se propone las ${hab.hora}: es la hora a la que `
          + `salió el ${hab.fecha_ref}, la última vez que entró a una hora parecida `
          + `(jornada de ${hab.horas} h). Confírmala o corrígela.`
        : "No hay hora programada ni un antecedente parecido: pregunta a qué hora terminó "
          + "de verdad y escríbela.";
    elements.cierreMotivoInput.value = "";
    setMessage(elements.cierreError, "");
    elements.cierreOpciones.innerHTML = MOTIVOS_SIN_CIERRE.map((m) =>
      `<button type="button" class="motivo-chip">${escapeHtml(m)}</button>`).join("");

    // El resumen es la parte explicativa: antes de confirmar se ve, en texto plano,
    // exactamente lo que va a quedar guardado y a nombre de quien.
    const pintarResumen = () => {
      const hora = elements.cierreHoraInput.value;
      const motivo = elements.cierreMotivoInput.value.trim();
      const horas = horasDeJornada(horaAbierta, hora);
      const ajuste = (horaProg && hora)
        ? horaAMinutos(hora) - horaAMinutos(horaProg) : null;
      const ajusteTxt = ajuste === null ? ""
        : ajuste === 0 ? " (igual a la programada)"
        : ` (${Math.abs(ajuste)} min ${ajuste > 0 ? "después" : "antes"} de la programada)`;

      // Si la hora declarada es anterior o igual a la de entrada, el turno cruzo la
      // medianoche y la salida cae al dia siguiente (mismo criterio que la base).
      const fechaSalida = (hora && horaAMinutos(hora) <= horaAMinutos(horaAbierta))
        ? sumarDiasIso(open.fecha, 1) : open.fecha;

      // Pasado el maximo de Buk se avisa aqui mismo: la marca se guarda, pero no
      // entra a nomina y queda como novedad que alguien tendra que responder.
      const excede = horas != null && horas > LIMITE_HORAS_JORNADA;
      const avisoHoras = excede
        ? `<li class="cierre-alerta">Pasa del máximo de <b>${LIMITE_HORAS_JORNADA} h</b> de Buk:
             la marca <b>no entrará a nómina</b> y queda como novedad de jornada extendida.</li>`
        : "";

      elements.cierreResumen.innerHTML = !hora
        ? `<em>Indica la hora de salida para ver qué se va a guardar.</em>`
        : `<strong>Va a quedar así:</strong>
           <ul>
             <li>SALIDA del <b>${escapeHtml(fechaSalida)}</b> a las <b>${escapeHtml(hora)}</b>${escapeHtml(ajusteTxt)}</li>
             <li>Jornada resultante: <b${excede ? ' class="cierre-alerta"' : ""}>${horas != null ? horas + " h" : "—"}</b></li>
             ${avisoHoras}
             <li>Motivo: ${motivo ? `<b>${escapeHtml(motivo)}</b>` : "<em>pendiente</em>"}</li>
             <li>Queda registrada <b>a tu nombre y con la fecha de hoy</b>, marcada como
                 declarada (no biométrica) y visible en Administración › Verificador de
                 horarios › Cierres declarados.</li>
           </ul>`;
    };
    // Al editar se repinta el resumen Y se borra el error: dejarlo puesto mostraba
    // una cifra vieja junto a la nueva, con dos numeros distintos en pantalla.
    const alEditar = () => { setMessage(elements.cierreError, ""); pintarResumen(); };

    pintarResumen();
    ov.classList.remove("hidden");
    setTimeout(() => elements.cierreHoraInput.focus(), 50);

    const onChip = (event) => {
      const chip = event.target.closest(".motivo-chip");
      if (!chip) return;
      elements.cierreMotivoInput.value = chip.textContent;   // editable por si detallan mas
      setMessage(elements.cierreError, "");
      pintarResumen();
    };
    const cleanup = () => {
      ov.classList.add("hidden");
      elements.cierreOpciones.removeEventListener("click", onChip);
      elements.cierreHoraInput.removeEventListener("input", alEditar);
      elements.cierreMotivoInput.removeEventListener("input", alEditar);
      elements.cierreAccept.removeEventListener("click", onAccept);
      elements.cierreCancel.removeEventListener("click", onCancel);
    };
    const onAccept = () => {
      const hora = elements.cierreHoraInput.value;
      const motivo = elements.cierreMotivoInput.value.trim();
      if (!/^\d{2}:\d{2}$/.test(hora)) {
        setMessage(elements.cierreError, "Indica la hora a la que terminó el turno.", "error");
        elements.cierreHoraInput.focus();
        return;
      }
      const horas = horasDeJornada(horaAbierta, hora);
      if (horas !== null && horas > CIERRE_HORAS_MAX) {
        setMessage(elements.cierreError,
          `Con esa hora la jornada daría ${horas} h, y la entrada fue a las ${horaAbierta}. `
          + `Eso es más del doble del máximo de ${LIMITE_HORAS_JORNADA} h de Buk: `
          + "revisa la hora antes de continuar.", "error");
        elements.cierreHoraInput.focus();
        return;
      }
      if (motivo.length < 4) {
        setMessage(elements.cierreError,
          "Escribe por qué no quedó registrada la salida, o elige un motivo de la lista.", "error");
        elements.cierreMotivoInput.focus();
        return;
      }
      cleanup();
      resolve({ hora, motivo });
    };
    const onCancel = () => { cleanup(); resolve(null); };

    elements.cierreOpciones.addEventListener("click", onChip);
    elements.cierreHoraInput.addEventListener("input", alEditar);
    elements.cierreMotivoInput.addEventListener("input", alEditar);
    elements.cierreAccept.addEventListener("click", onAccept);
    elements.cierreCancel.addEventListener("click", onCancel);
  });
}

// Cierra el turno anterior en la hora que DECLARA el operario y deja la marca de hoy
// como ENTRADA. Devuelve true si el turno quedo cerrado.
async function ofrecerCierreTurnoAnterior(sug) {
  const open = state.openEntrada;
  if (!open?.id) return false;
  const dni = state.colaborador?.dni || open.dni || normalizeDni(elements.dniInput?.value);
  const horaAbierta = String(open.hora || "").slice(0, 5);
  const sugerencia = await sugerenciaCierre(open.id);

  const nombre = state.colaborador?.nombre || state.csvCandidate?.nombre || "";
  const decl = await pedirCierreTurno({
    open, horaAbierta, sugerencia, horaTurnoHoy: sug?.turno?.hora_entrada || "", nombre
  });

  // Si no lo declara, el turno pendiente queda marcado y la ENTRADA de hoy no se
  // admite: registrarla dejaria dos turnos abiertos y la salida vieja se perderia.
  if (!decl) {
    state.cierrePendiente = {
      fecha: open.fecha,
      hora: horaAbierta,
      horaProg: sugerencia?.programada?.hora || sugerencia?.habitual?.hora || "",
      nombre
    };
    renderProgramacionBanner();
    setMessage(elements.formMessage,
      `No se puede registrar la entrada: falta cerrar el turno del ${open.fecha} `
      + `(entrada ${horaAbierta} sin salida).`, "error");
    return false;
  }

  try {
    const { data, error } = await supabaseClient.rpc("cerrar_turno_automatico", {
      p_entrada_id: open.id, p_hora: decl.hora, p_motivo: decl.motivo
    });
    if (error) throw new Error(error.message);
    if (!data?.ok) {
      // Si el turno ya tenia salida, el estado en pantalla estaba viejo: se recarga
      // en vez de dejar bloqueado a quien si puede marcar.
      await loadLastAttendance(dni);
      computeOpenEntrada();
      showAlertModal(
        "No se pudo cerrar el turno anterior",
        `${data?.error || "Error cerrando el turno."} `
        + "Revisa el caso en Administración › Verificador de horarios."
      );
      return false;
    }
    // Si el cierre declarado pasa de 16 h, el trigger ya creo la novedad: se le pone
    // el mismo motivo que dio quien lo declaro, para que no nazca "sin explicar".
    if (data.horas_jornada > LIMITE_HORAS_JORNADA) {
      await explicarJornadaExcedida(data.id, decl.motivo);
    }

    // El turno quedo cerrado: se recarga el estado para que ya no figure abierto.
    await loadLastAttendance(dni);
    computeOpenEntrada();
    state.cierrePendiente = null;
    renderProgramacionBanner();
    const ajuste = data.minutos_ajuste;
    setMessage(elements.formMessage,
      `Turno del ${data.entrada_fecha} cerrado a las ${data.hora}`
      + (ajuste ? ` (${Math.abs(ajuste)} min ${ajuste > 0 ? "después" : "antes"} de lo programado)` : "")
      + `. Motivo: ${decl.motivo}. Ahora registra la ENTRADA de hoy.`, "success");
    return true;
  } catch (e) {
    showAlertModal("No se pudo cerrar el turno anterior", e.message || String(e));
    return false;
  }
}

// Si se cambia la fecha/hora del reporte (modo local, para pruebas) hay que volver a
// consultar la programacion de ESE dia: si no, se sigue viendo el turno del dia en
// que se valido la cedula. No se vuelve a lanzar el cierre automatico del turno
// anterior: eso solo debe ocurrir al validar, no cada vez que se toca la fecha.
let refrescoFechaTimer = null;
function refrescarPorFechaReporte() {
  const dni = normalizeDni(elements.dniInput?.value);
  if (!dni || (!state.csvCandidate && !state.colaborador)) return;

  clearTimeout(refrescoFechaTimer);
  refrescoFechaTimer = setTimeout(async () => {
    await cargarProgramacionDia(dni);
    await cargarEstadoTurno(dni);
    // Se recalcula la sugerencia del horario, pero sin tocar el sentido ya elegido
    // ni disparar dialogos: quien registra decide con el aviso a la vista.
    state.sentidoSegunProgramacion = sentidoSugeridoPorProgramacion();
    renderProgramacionBanner();
    renderSentidoSelector();
    updateVehicleHint();
  }, 350);
}

// Decide el sentido inicial dando prioridad a la programacion sobre la ultima marca.
async function resolverSentidoInicial() {
  const sug = sentidoSugeridoPorProgramacion();
  state.sentidoSegunProgramacion = sug;
  state.sentidoForzadoManual = false;

  // Sin turno abierto solo cabe una ENTRADA (una salida sin entrada se rechaza).
  if (!state.openEntrada) {
    state.nextSentido = "entrada";
    return;
  }

  // Sin programacion confiable se conserva el criterio anterior.
  if (!sug || sug.dist > SENTIDO_PROG_MAX_MIN) {
    state.nextSentido = "salida";
    return;
  }

  // El horario dice que esta LLEGANDO pero arrastra un turno sin cerrar: se cierra
  // el viejo en vez de invertir el sentido. Si no lo declaran, el sentido SIGUE
  // siendo entrada y queda bloqueado (state.cierrePendiente): pasar a salida seria
  // cerrar el turno viejo con la hora de hoy, que es justo el error a evitar.
  if (sug.sentido === "entrada") {
    await ofrecerCierreTurnoAnterior(sug);
    state.nextSentido = "entrada";
    return;
  }

  state.nextSentido = "salida";
}

/* ==========================================================================
   Agenda de celulares para el comprobante por WhatsApp
   Guarda el celular por cedula en la tabla `contactos_whatsapp`, para que al
   digitar la cedula el numero aparezca solo y no haya que escribirlo cada vez.
   ========================================================================== */

// Misma normalizacion que normalizar_celular_co() en la base: 10 digitos, inicia en 3.
function normalizarCelularCo(valor) {
  let v = String(valor || "").replace(/[^0-9]/g, "");
  if (v.length === 12 && v.startsWith("57")) v = v.slice(2);
  else if (v.length === 11 && v.startsWith("0")) v = v.slice(1);
  if (v.length !== 10 || !v.startsWith("3")) return "";
  return v;
}

function enmascararCelular(cel) {
  const v = String(cel || "");
  if (v.length < 7) return v;
  return `${v.slice(0, 3)}•••${v.slice(-4)}`;
}

function renderCelularAgenda() {
  const hint = elements.celularAgendaHint;
  if (!hint) return;

  const dni = state.celularAgendaDni;
  if (!dni) {
    hint.classList.add("hidden");
    return;
  }

  const guardado = state.celularAgendaGuardado;
  hint.classList.remove("hidden");
  if (guardado) {
    hint.className = "comprobante-agenda guardado";
    hint.textContent = `Numero guardado para esta cedula: ${enmascararCelular(guardado)}. Puedes cambiarlo si el conductor lo pide.`;
  } else {
    hint.className = "comprobante-agenda sin-guardar";
    hint.textContent = "Esta cedula no tiene un numero guardado. Al digitarlo la aplicacion te preguntara si deseas guardarlo.";
  }
}

function limpiarCelularAgenda() {
  state.celularAgendaDni = "";
  state.celularAgendaGuardado = "";
  state.celularAgendaPreguntado = "";
  if (elements.celularComprobanteInput) elements.celularComprobanteInput.value = "";
  renderCelularAgenda();
}

// Pregunta (modal) si se guarda el numero en la agenda. Se dispara sola: al salir
// del campo y, si no alcanzo a preguntarse, tambien al registrar la marca.
// Devuelve true si ya se resolvio la pregunta para ese numero.
async function preguntarGuardarCelular() {
  if (state.celularAgendaPreguntando) return false;

  const dni = state.celularAgendaDni;
  const celular = normalizarCelularCo(elements.celularComprobanteInput?.value);
  if (!dni || !celular) return false;
  if (celular === state.celularAgendaGuardado) return true;
  if (celular === state.celularAgendaPreguntado) return true;

  state.celularAgendaPreguntando = true;
  state.celularAgendaPreguntado = celular;
  try {
    const guardar = await confirmGraphical(
      state.celularAgendaGuardado ? "¿Actualizar el número guardado?" : "¿Guardar este número?",
      state.celularAgendaGuardado
        ? `Esta cédula tenía guardado el número ${enmascararCelular(state.celularAgendaGuardado)}. ¿Deseas reemplazarlo por ${celular} para las próximas marcas?`
        : `¿Deseas guardar el número ${celular} para esta cédula? Así aparecerá solo la próxima vez y no habrá que digitarlo.`,
      "Sí, guardar",
      "No, solo esta vez"
    );
    if (guardar) await guardarCelularAgenda({ silencioso: true });
  } finally {
    state.celularAgendaPreguntando = false;
  }
  return true;
}

async function cargarCelularAgenda(dni) {
  // Si el numero visible era el autocompletado de OTRA cedula, se limpia para
  // no arrastrar el celular de un conductor al siguiente.
  const previo = state.celularAgendaGuardado;
  if (previo && dni !== state.celularAgendaDni
      && normalizarCelularCo(elements.celularComprobanteInput?.value) === previo) {
    elements.celularComprobanteInput.value = "";
  }

  state.celularAgendaDni = dni || "";
  state.celularAgendaGuardado = "";
  state.celularAgendaPreguntado = "";
  if (!dni) {
    renderCelularAgenda();
    return;
  }

  try {
    const { data, error } = await supabaseClient.rpc("obtener_celular_colaborador", { p_dni: dni });
    if (error) throw error;
    if (data?.ok && data.existe && data.celular) {
      state.celularAgendaGuardado = String(data.celular);
      // Se autocompleta solo si el usuario no escribio otro numero a mano.
      const actual = normalizarCelularCo(elements.celularComprobanteInput?.value);
      if (!actual && elements.celularComprobanteInput) {
        elements.celularComprobanteInput.value = state.celularAgendaGuardado;
      }
    }
  } catch (e) {
    console.warn("No se pudo consultar la agenda de celulares:", e?.message || e);
  }
  renderCelularAgenda();
}

async function guardarCelularAgenda({ silencioso = false } = {}) {
  const dni = state.celularAgendaDni || normalizeDni(elements.dniInput.value);
  const celular = normalizarCelularCo(elements.celularComprobanteInput?.value);

  if (!dni) {
    if (!silencioso) setMessage(elements.formMessage, "Primero valida la cedula.", "error");
    return false;
  }
  if (!celular) {
    if (!silencioso) {
      setMessage(elements.formMessage, "El celular debe tener 10 digitos y empezar por 3.", "error");
      elements.celularComprobanteInput?.focus();
    }
    return false;
  }

  try {
    const { data, error } = await supabaseClient.rpc("guardar_celular_colaborador", {
      p_dni: dni,
      p_celular: celular,
      p_nombre: state.csvCandidate?.nombre || state.colaborador?.nombre || null
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || "No se pudo guardar el numero.");

    state.celularAgendaDni = dni;
    state.celularAgendaGuardado = celular;
    state.celularAgendaPreguntado = celular;
    if (elements.celularComprobanteInput) elements.celularComprobanteInput.value = celular;
    renderCelularAgenda();
    if (!silencioso) setMessage(elements.formMessage, "Numero guardado para esta cedula.", "success");
    return true;
  } catch (e) {
    if (!silencioso) setMessage(elements.formMessage, e?.message || "No se pudo guardar el numero.", "error");
    return false;
  }
}

function scheduleDniValidation() {
  if (!requireOnline()) return;
  window.clearTimeout(state.dniValidationTimer);
  resetCaptureState(true);
  stopCamera();

  const dni = normalizeDni(elements.dniInput.value);
  if (!dni) {
    elements.collaboratorBox.className = "result-box muted";
    elements.collaboratorBox.textContent = "Digita una cedula para validar si esta activa.";
    limpiarCelularAgenda();
    limpiarProgramacion();
    return;
  }

  elements.collaboratorBox.className = "result-box muted";
  elements.collaboratorBox.textContent = "Validando cedula...";

  state.dniValidationTimer = window.setTimeout(() => {
    buscarColaborador();
  }, 450);
}

async function buscarColaborador() {
  if (!requireOnline()) return;
  const dni = normalizeDni(elements.dniInput.value);
  resetCaptureState(false);

  if (!dni) {
    elements.collaboratorBox.className = "result-box muted";
    elements.collaboratorBox.textContent = "Digita una cedula para validar si esta activa.";
    limpiarCelularAgenda();
    limpiarProgramacion();
    stopCamera();
    return;
  }

  const csvCollaborator = await findActiveCsvCollaborator(dni);
  if (!csvCollaborator) {
    elements.collaboratorBox.className = "result-box";
    elements.collaboratorBox.textContent = "Registro rechazado: la cedula no esta activa en la base de colaboradores.";
    setMessage(elements.formMessage, "Cedula no autorizada para registrar asistencia.", "error");
    configureDriverFields(null);
    hideDriverGreetingCard();
    stopCamera();
    return;
  }

  state.csvCandidate = csvCollaborator;
  configureDriverFields(csvCollaborator);
  cargarCelularAgenda(dni);
  if (isDriverCollaborator(csvCollaborator)) {
    await prepareAttendanceDriverIntegration(csvCollaborator, dni);
  }
  setBusy(elements.searchButton, true);
  elements.collaboratorBox.className = "result-box muted";
  elements.collaboratorBox.textContent = "Consultando registro local...";

  const { data, error } = await supabaseClient
    .from("colaboradores")
    .select("id,dni,nombre,empresa,contrato,especialidad,estado,obra_id,foto_referencia_path,rostro_enrolado,obras(nombre,obra_id_externo)")
    .eq("dni", dni)
    .maybeSingle();

  setBusy(elements.searchButton, false);

  if (error) {
    elements.collaboratorBox.className = "result-box";
    elements.collaboratorBox.textContent = "No se pudo validar la cedula en Supabase.";
    setMessage(elements.formMessage, error.message || "Error validando cedula.", "error");
    return;
  }

  state.colaborador = data || null;
  await loadLastAttendance(dni);
  await loadLastEntradaForDni(dni);
  computeOpenEntrada();
  // El horario se consulta ANTES de decidir el sentido: la programacion sabe si la
  // persona esta llegando o saliendo, la ultima marca solo sabe que paso antes.
  await cargarProgramacionDia(dni);
  await cargarEstadoTurno(dni);
  await resolverSentidoInicial();
  renderSentidoSelector();
  updateVehicleHint();   // ya se sabe si hay programacion: el vehiculo puede ser opcional
  const faceStatus = state.isDriverCandidate
    ? (data?.rostro_enrolado ? "Conductor con rostro enrolado: se intentara validacion biometrica." : "Conductor sin rostro enrolado: se intentara detectar rostro.")
    : "Foto obligatoria como evidencia. Biometria no requerida para este cargo.";
  const openInfo = getOpenAttendanceInfo();
  elements.collaboratorBox.className = "result-box";
  elements.collaboratorBox.innerHTML = `
    <strong>${escapeHtml(csvCollaborator.nombre || "Colaborador activo")}</strong>
    <div>Cedula: ${escapeHtml(csvCollaborator.cedula)}</div>
    <div>Cargo: ${escapeHtml(csvCollaborator.cargo || "Sin cargo")}</div>
    <div>Empresa: ${escapeHtml(csvCollaborator.empresa || "Sin empresa")}</div>
    <div>Vehiculo: ${escapeHtml(csvCollaborator.vehiculo || "Sin vehiculo")}</div>
    <div>Ruta: ${escapeHtml(csvCollaborator.ruta || "Sin ruta")}</div>
    ${state.isDriverCandidate ? `<div>driverId Sonar: ${escapeHtml(state.attendanceSonarDriver?.dr_id || "No encontrado")}</div>` : ""}
    ${state.isDriverCandidate ? `<div>mId Sonar: ${escapeHtml(getSelectedVehicle()?.m_id || "No encontrado")}</div>` : ""}
    <div>${data ? "Validado localmente." : "Validado por CSV. Se creara localmente al registrar."}</div>
    <div>${renderLastEntradaLabel(state.lastEntrada)}</div>
    <div>${renderTurnoEstadoLabel()}</div>
    <div>${escapeHtml(faceStatus)}</div>
    <div>Proxima marca permitida: ${escapeHtml(state.nextSentido)}</div>
    ${openInfo ? `<div>${escapeHtml(openInfo)}</div>` : ""}
  `;
  renderTurnoStatusBanner();
  elements.locationSection?.classList.remove("hidden");
  captureCurrentLocation();

  if (openInfo && state.nextSentido === "salida") {
    // Turno abierto que SI corresponde cerrar (el horario no lo contradijo).
    setSentido("salida");
  } else if (state.nextSentido === "entrada" && state.lastAttendance?.sentido === "salida") {
    const last = state.lastAttendance;
    const today = getTodayParts().date;
    if (last.fecha && last.fecha < today) {
      const diffDias = diffDaysBetween(last.fecha, today);
      if (diffDias >= 2) {
        showAlertModal(
          "Verifica tus marcas",
          `Tu ultima marca fue una salida el ${last.fecha} (${diffDias} dias atras). Si olvidaste registrar una entrada o salida intermedia, avisa al administrador antes de continuar.`
        );
      }
    }
  }

  // La camara no se abre sola: primero hay que confirmar identidad y sentido.
  mostrarConfirmacionIdentidad();
}

function diffDaysBetween(fromDate, toDate) {
  const a = new Date(`${fromDate}T00:00:00`);
  const b = new Date(`${toDate}T00:00:00`);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function startCamera() {
  const messageTarget = state.cameraMode === "enroll" ? elements.enrollMessage : elements.formMessage;
  if (!requireOnline(messageTarget)) return;
  if (state.cameraMode === "attendance" && !state.csvCandidate) {
    setMessage(messageTarget, "Primero valida una cedula activa.", "error");
    return;
  }
  if (state.cameraMode === "enroll" && !state.enrollCandidate) {
    setMessage(messageTarget, "Primero valida una cedula activa.", "error");
    return;
  }

  if (state.cameraStream) {
    elements.cameraBox.classList.remove("hidden");
    return;
  }

  try {
    state.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    elements.cameraVideo.srcObject = state.cameraStream;
    elements.cameraBox.classList.remove("hidden");
    state.liveFaceOk = false;
    state.cameraOpenedAt = Date.now();
    elements.captureButton.disabled = true;
    elements.faceGuide.classList.remove("ready", "error");
    if (isEvidenceOnlyMode()) {
      state.liveFaceOk = true;
      elements.captureButton.disabled = false;
      elements.faceGuide.classList.add("ready");
      elements.liveFaceStatus.textContent = "Toma una foto frontal como evidencia. La validacion biometrica solo aplica para conductores.";
      setMessage(messageTarget, "Foto de evidencia obligatoria. Biometria solo para conductores.", "success");
    } else {
      setMessage(messageTarget, "Ubica el rostro dentro del recuadro y captura.", "");
      scheduleAttendanceFaceFallback();
      initFaceDetector().then((ready) => {
        if (ready) {
          startLiveFaceDetection();
        } else {
          elements.liveFaceStatus.textContent = "El lector facial no cargo. Toma una foto frontal para registrar con evidencia.";
        }
      });
    }
  } catch (_error) {
    setMessage(messageTarget, "No se pudo abrir la camara.", "error");
  }
}

async function startEnrollCamera() {
  if (!requireOnline(elements.enrollMessage)) return;
  if (!state.enrollCandidate) {
    setMessage(elements.enrollMessage, "Primero valida una cedula activa.", "error");
    return;
  }

  state.cameraMode = "enroll";
  await startCamera();
}

function stopCamera() {
  state.liveDetectionRunning = false;
  state.liveFaceOk = false;
  state.cameraOpenedAt = 0;
  if (state.cameraFallbackTimer) {
    clearTimeout(state.cameraFallbackTimer);
    state.cameraFallbackTimer = null;
  }
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((track) => track.stop());
    state.cameraStream = null;
  }
  elements.captureButton.disabled = true;
  elements.faceGuide.classList.remove("ready", "error");
  elements.cameraBox.classList.add("hidden");
}

function scheduleAttendanceFaceFallback() {
  if (state.cameraFallbackTimer) {
    clearTimeout(state.cameraFallbackTimer);
    state.cameraFallbackTimer = null;
  }

  if (state.cameraMode !== "attendance") return;

  state.cameraFallbackTimer = setTimeout(() => {
    state.cameraFallbackTimer = null;
    if (!state.cameraStream || state.liveFaceOk || state.cameraMode !== "attendance") return;
    elements.captureButton.disabled = false;
    elements.liveFaceStatus.textContent = "Puedes capturar la foto. Si el lector facial no responde, la asistencia se registra con advertencia.";
    elements.faceGuide.classList.add("error");
  }, FACE_FALLBACK_DELAY_MS);
}

async function startLiveFaceDetection() {
  if (!state.faceDetectorReady || state.liveDetectionRunning) return;

  state.liveDetectionRunning = true;
  let lastRun = 0;

  const loop = async () => {
    if (!state.liveDetectionRunning || !state.cameraStream) return;

    const now = performance.now();
    if (elements.cameraVideo.videoWidth && now - lastRun > 260) {
      lastRun = now;
      try {
        const result = state.faceDetector.detect(elements.cameraVideo);
        const status = validateDetectedFaces(
          result.detections || [],
          elements.cameraVideo.videoWidth,
          elements.cameraVideo.videoHeight
        );
        state.liveFaceOk = status.ok;
        elements.captureButton.disabled = !status.ok && !canUseAttendanceFaceFallback();
        elements.liveFaceStatus.textContent = status.ok
          ? "Rostro validado en tiempo real. Puedes capturar."
          : canUseAttendanceFaceFallback()
            ? `${status.message} Puedes capturar y registrar con advertencia.`
            : status.message;
        elements.faceGuide.classList.toggle("ready", status.ok);
        elements.faceGuide.classList.toggle("error", !status.ok);
      } catch (_error) {
        state.liveFaceOk = false;
        elements.captureButton.disabled = !canUseAttendanceFaceFallback();
        elements.liveFaceStatus.textContent = canUseAttendanceFaceFallback()
          ? "El lector facial no responde. Puedes capturar y registrar con advertencia."
          : "Validando rostro...";
      }
    }

    requestAnimationFrame(loop);
  };

  requestAnimationFrame(loop);
}

function canUseAttendanceFaceFallback() {
  return state.cameraMode === "attendance"
    && state.cameraOpenedAt > 0
    && Date.now() - state.cameraOpenedAt >= FACE_FALLBACK_DELAY_MS;
}

async function capturePhoto() {
  if (!isEvidenceOnlyMode() && !state.liveFaceOk && !canUseAttendanceFaceFallback()) {
    setMessage(elements.formMessage, "Ubica un rostro claro dentro del recuadro antes de capturar.", "error");
    return;
  }

  const video = elements.cameraVideo;
  if (!video.videoWidth || !video.videoHeight) {
    setMessage(elements.formMessage, "La camara aun no esta lista.", "error");
    return;
  }

  // Aprovechamos el gesto del boton "Tomar foto" (obligatorio en movil para el
  // permiso de GPS) para capturar la ubicacion automaticamente, sin que el
  // usuario tenga que tocar "Activar ubicacion". Corre en paralelo.
  if (state.cameraMode === "attendance" && !state.currentLocation) {
    captureCurrentLocation();
  }

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));

  if (state.cameraMode === "enroll") {
    await saveReferenceFace(new File([blob], "referencia.jpg", { type: "image/jpeg" }));
    return;
  }

  const ok = await prepareImageFile(new File([blob], "camara.jpg", { type: "image/jpeg" }));

  if (ok) {
    stopCamera();
    setWorkflowState("register");
  }
}

async function prepareImageFile(file) {
  setMessage(elements.formMessage, isEvidenceOnlyMode() ? "Preparando foto de evidencia..." : "Comprimiendo y validando rostro...");
  // En movil la foto se comprime MAS fuerte (menos peso = subida rapida y menos datos).
  const esMovilCaptura = state.deviceMode === "mobile";
  const compressed = esMovilCaptura
    ? await compressImage(file, 512, 0.55, 130000)
    : await compressImage(file, 720, 0.72);
  const previewUrl = URL.createObjectURL(compressed);
  const evidenceOnly = isEvidenceOnlyMode();
  const faceCheck = evidenceOnly
    ? { ok: true, message: "Foto de evidencia lista. Ahora puedes registrar la asistencia." }
    : state.liveFaceOk
    ? { ok: true, message: "Rostro validado. Ya puedes registrar la asistencia." }
    : await runOptionalFaceCheck(() => validateFaceInImage(previewUrl), FACE_IMAGE_CHECK_TIMEOUT_MS, "La validacion facial tardo demasiado.");

  if (evidenceOnly) {
    state.faceWarning = "";
  } else if (!faceCheck.ok) {
    state.faceWarning = faceCheck.message;
  }

  if (!evidenceOnly && state.cameraMode === "attendance" && state.colaborador?.rostro_enrolado && state.colaborador?.foto_referencia_path) {
    setMessage(elements.formMessage, "Comparando rostro con referencia enrolada...");
    const identityCheck = await runOptionalFaceCheck(
      () => verifyFaceIdentity(previewUrl, state.colaborador.foto_referencia_path),
      FACE_IDENTITY_TIMEOUT_MS,
      "La comparacion con el rostro enrolado tardo demasiado."
    );
    if (!identityCheck.ok) {
      state.faceWarning = state.faceWarning
        ? `${state.faceWarning} ${identityCheck.message}`
        : identityCheck.message;
    }
  }

  state.compressedFile = compressed;
  state.faceValidated = true;
  elements.photoPreview.src = previewUrl;
  elements.photoName.textContent = compressed.name;
  elements.photoSize.textContent = `${Math.round(compressed.size / 1024)} KB`;
  elements.previewBox.classList.remove("hidden");
  setMessage(
    elements.formMessage,
    evidenceOnly
      ? "Foto lista. Ahora toca el boton Registrar asistencia para guardar la marca."
      : state.faceWarning
      ? `Foto lista. Advertencia facial: ${state.faceWarning} La asistencia se puede registrar con evidencia fotografica.`
      : faceCheck.message,
    evidenceOnly ? "success" : (state.faceWarning ? "error" : "success")
  );
  return true;
}

async function runOptionalFaceCheck(checkFn, timeoutMs, timeoutMessage) {
  try {
    return await withTimeout(checkFn(), timeoutMs, { ok: false, message: timeoutMessage });
  } catch (error) {
    return {
      ok: false,
      message: error?.message || "No se pudo completar la validacion facial."
    };
  }
}

function withTimeout(promise, timeoutMs, fallbackValue) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
    Promise.resolve(promise)
      .then((value) => resolve(value))
      .catch((error) => resolve({ ok: false, message: error?.message || fallbackValue.message }))
      .finally(() => clearTimeout(timer));
  });
}

async function initFaceDetector() {
  if (state.faceDetectorReady) return true;

  try {
    if (!state.visionTasks) {
      state.visionTasks = window.vision?.FilesetResolver
        ? window.vision
        : await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs");
    }

    const vision = await state.visionTasks.FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm"
    );
    const baseOptions = {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite"
    };
    const taskOptions = {
      runningMode: "IMAGE",
      minDetectionConfidence: 0.85,
      minSuppressionThreshold: 0.3
    };

    try {
      state.faceDetector = await state.visionTasks.FaceDetector.createFromOptions(vision, {
        baseOptions: { ...baseOptions, delegate: "GPU" },
        ...taskOptions
      });
    } catch (_gpuError) {
      state.faceDetector = await state.visionTasks.FaceDetector.createFromOptions(vision, {
        baseOptions,
        ...taskOptions
      });
    }

    state.faceDetectorReady = true;
    return true;
  } catch (_error) {
    return false;
  }
}

async function validateFaceInImage(imageUrl) {
  const image = await loadImageFromUrl(imageUrl);

  if (await initFaceDetector()) {
    const result = state.faceDetector.detect(image);
    return validateDetectedFaces(result.detections || [], image.naturalWidth, image.naturalHeight);
  }

  if ("FaceDetector" in window) {
    const detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 2 });
    const faces = await detector.detect(image);
    return validateDetectedFaces(faces, image.naturalWidth, image.naturalHeight);
  }

  return {
    ok: false,
    message: "No se pudo cargar el validador facial. Revisa internet y recarga la pagina."
  };
}

async function initFaceApi() {
  if (state.faceApiReady) return true;
  if (!window.faceapi) return false;

  try {
    const modelUrl = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights";
    await Promise.all([
      window.faceapi.nets.ssdMobilenetv1.loadFromUri(modelUrl),
      window.faceapi.nets.faceLandmark68Net.loadFromUri(modelUrl),
      window.faceapi.nets.faceRecognitionNet.loadFromUri(modelUrl)
    ]);
    state.faceApiReady = true;
    return true;
  } catch (_error) {
    return false;
  }
}

async function verifyFaceIdentity(capturedImageUrl, referencePath) {
  if (!(await initFaceApi())) {
    return {
      ok: false,
      message: "No se pudo cargar el modelo de verificacion facial. Revisa internet y recarga."
    };
  }

  const { data, error } = await supabaseClient.storage
    .from("rostros-referencia")
    .download(referencePath);

  if (error || !data) {
    return {
      ok: false,
      message: "No se pudo cargar el rostro de referencia del colaborador."
    };
  }

  const referenceUrl = URL.createObjectURL(data);
  const capturedImage = await loadImageFromUrl(capturedImageUrl);
  const referenceImage = await loadImageFromUrl(referenceUrl);

  const captured = await window.faceapi
    .detectSingleFace(capturedImage)
    .withFaceLandmarks()
    .withFaceDescriptor();

  const reference = await window.faceapi
    .detectSingleFace(referenceImage)
    .withFaceLandmarks()
    .withFaceDescriptor();

  URL.revokeObjectURL(referenceUrl);

  if (!captured) {
    return { ok: false, message: "No se pudo extraer descriptor del rostro capturado." };
  }

  if (!reference) {
    return { ok: false, message: "El rostro de referencia guardado no es valido." };
  }

  const distance = window.faceapi.euclideanDistance(captured.descriptor, reference.descriptor);
  if (distance > 0.5) {
    return {
      ok: false,
      message: `El rostro no coincide con la referencia enrolada. Distancia: ${distance.toFixed(2)}`
    };
  }

  return {
    ok: true,
    message: `Identidad facial verificada. Distancia: ${distance.toFixed(2)}`
  };
}

function validateDetectedFaces(faces, imageWidth, imageHeight) {
  if (!faces.length) {
    return { ok: false, message: "No se detecto un rostro claro. Toma una foto frontal dentro del recuadro." };
  }

  if (faces.length > 1) {
    return { ok: false, message: "Se detecto mas de un rostro. Debe aparecer solo el colaborador." };
  }

  const score = faces[0].categories?.[0]?.score ?? faces[0].score?.[0] ?? 1;
  if (score < 0.55) {
    return { ok: false, message: "El rostro no es suficientemente claro. Mejora la luz y vuelve a capturar." };
  }

  const box = faces[0].boundingBox || faces[0].box;
  const x = Array.isArray(box) ? box[0] : box.originX ?? box.x ?? 0;
  const y = Array.isArray(box) ? box[1] : box.originY ?? box.y ?? 0;
  const width = Array.isArray(box) ? box[2] : box.width;
  const height = Array.isArray(box) ? box[3] : box.height;
  const faceArea = width * height;
  const imageArea = imageWidth * imageHeight;

  const faceRatio = faceArea / imageArea;
  if (faceRatio < 0.035) {
    return { ok: false, message: "El rostro esta muy pequeno. Acerca la camara y vuelve a capturar." };
  }

  if (faceRatio > 0.78) {
    return { ok: false, message: "El rostro esta demasiado cerca. Alejate un poco de la camara." };
  }

  const faceCenterX = x + width / 2;
  const faceCenterY = y + height / 2;
  const guideLeft = imageWidth * 0.08;
  const guideRight = imageWidth * 0.92;
  const guideTop = imageHeight * 0.06;
  const guideBottom = imageHeight * 0.94;

  if (
    faceCenterX < guideLeft ||
    faceCenterX > guideRight ||
    faceCenterY < guideTop ||
    faceCenterY > guideBottom
  ) {
    return { ok: false, message: "Centra el rostro dentro del recuadro." };
  }

  const aspectRatio = width / height;
  if (aspectRatio < 0.35 || aspectRatio > 1.65) {
    return { ok: false, message: "Toma la foto de frente, sin girar demasiado el rostro." };
  }

  return { ok: true, message: "Rostro validado. Ya puedes registrar la asistencia." };
}

function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

async function compressImage(file, maxSize, quality, maxBytes = 650000) {
  const image = await loadImage(file);
  const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);

  let currentQuality = quality;
  let blob = await canvasToBlob(canvas, currentQuality);

  while (blob.size > maxBytes && currentQuality > 0.38) {
    currentQuality -= 0.08;
    blob = await canvasToBlob(canvas, currentQuality);
  }

  return new File([blob], `${Date.now()}-asistencia.webp`, { type: "image/webp" });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = URL.createObjectURL(file);
  });
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
}

function getTodayParts() {
  return getTrustedNowParts();
}

function getTodayPartsFromDate(now) {
  // Extrae fecha/hora SIEMPRE en horario de Colombia (America/Bogota), sin importar
  // la zona horaria del dispositivo. Antes usaba getHours()/getDate() (hora LOCAL
  // del equipo): en un equipo con la zona en UTC, la hora salía corrida ~5h hacia
  // adelante y Buk rechazaba la marca como "fecha futura".
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const p = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  const hour = p.hour === "24" ? "00" : p.hour; // algunos motores dan "24" a medianoche
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${hour}:${p.minute}:${p.second}`
  };
}

function setupManualDefaults() {
  const now = getTodayParts();
  elements.manualDateInput.value = now.date;
  elements.manualTimeInput.value = now.time.slice(0, 5);
}

function setupHistoryDefaults() {
  if (elements.historyStartDateInput.value || elements.historyEndDateInput.value) return;
  const now = getTodayParts();
  elements.historyStartDateInput.value = `${now.year}-${now.month}-01`;
  elements.historyEndDateInput.value = now.date;
}

async function getLocation() {
  if (!navigator.geolocation) {
    return { error: "unsupported", message: "Tu navegador no soporta geolocalizacion." };
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        latitud: position.coords.latitude,
        longitud: position.coords.longitude,
        precision: position.coords.accuracy
      }),
      (err) => {
        const code = err?.code;
        if (code === 1) resolve({ error: "denied", message: "Permiso de ubicacion denegado." });
        else if (code === 2) resolve({ error: "unavailable", message: "No se pudo determinar tu ubicacion. Activa el GPS." });
        else if (code === 3) resolve({ error: "timeout", message: "Tardamos mucho en obtener tu ubicacion. Intenta de nuevo." });
        else resolve({ error: "unknown", message: err?.message || "No se pudo obtener la ubicacion." });
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  });
}

function showLocationPermissionHelp(show) {
  if (!elements.locationPermissionHelp) return;
  elements.locationPermissionHelp.classList.toggle("hidden", !show);
}

function renderLocationMap(latitud, longitud, precision) {
  if (!elements.locationMap || typeof window.L === "undefined") return;
  elements.locationMap.classList.remove("is-loading");
  elements.locationMap.classList.add("is-visible");

  // Si el contenedor aun no tiene tamaño (panel oculto / sin layout), Leaflet se
  // cae al calcular offsetWidth. Reintentamos cuando el div ya tenga dimensiones.
  if (!state.locationMap && !elements.locationMap.offsetWidth) {
    setTimeout(() => renderLocationMap(latitud, longitud, precision), 200);
    return;
  }

  if (!state.locationMap) {
    state.locationMap = window.L.map(elements.locationMap, {
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: false
    }).setView([latitud, longitud], 17);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap"
    }).addTo(state.locationMap);
  } else {
    state.locationMap.setView([latitud, longitud], 17);
  }

  if (state.locationMarker) {
    state.locationMarker.setLatLng([latitud, longitud]);
  } else {
    state.locationMarker = window.L.marker([latitud, longitud]).addTo(state.locationMap);
  }

  if (state.locationAccuracyCircle) state.locationAccuracyCircle.remove();
  if (precision && Number.isFinite(precision)) {
    state.locationAccuracyCircle = window.L.circle([latitud, longitud], {
      radius: precision,
      color: "#0b6b3a",
      fillColor: "#0b6b3a",
      fillOpacity: 0.12,
      weight: 1
    }).addTo(state.locationMap);
  }

  setTimeout(() => state.locationMap?.invalidateSize(), 120);
}

async function estadoPermisoUbicacion() {
  try {
    if (navigator.permissions?.query) {
      const status = await navigator.permissions.query({ name: "geolocation" });
      return status.state; // 'granted' | 'prompt' | 'denied'
    }
  } catch (_) { /* algunos navegadores no soportan Permissions API */ }
  return "unknown";
}

function mostrarInstruccionesUbicacionDenegada() {
  elements.locationSection?.classList.remove("hidden");
  showLocationPermissionHelp(true);
  elements.locationButton.textContent = "Reintentar ubicación";
  showAlertModal(
    "Debes habilitar la ubicación",
    "La ubicación es OBLIGATORIA y está bloqueada en este navegador. Toca el candado (o la 'i') que está junto a la dirección web, entra en Ubicación y elige Permitir. En el celular revisa también que el GPS esté encendido. Luego toca 'Activar ubicación'. Sin ubicación no se puede registrar."
  );
}

async function captureCurrentLocation() {
  if (!requireOnline()) return null;

  // Verifica el permiso antes de intentar: si esta bloqueado, guia para habilitarlo.
  const permiso = await estadoPermisoUbicacion();
  if (permiso === "denied") {
    state.currentLocation = null;
    elements.locationStatus.textContent = "Ubicación BLOQUEADA en el navegador. Debes habilitarla para registrar.";
    elements.locationMap?.classList.remove("is-loading", "is-visible");
    if (elements.locationMap) elements.locationMap.textContent = "";
    mostrarInstruccionesUbicacionDenegada();
    syncSubmitLockPorUbicacion();
    return null;
  }

  elements.locationStatus.textContent = "Pidiendo permiso y validando coordenadas...";
  elements.locationButton.disabled = true;
  elements.locationMap?.classList.add("is-loading", "is-visible");
  // No sobreescribir el contenido si Leaflet ya creo el mapa dentro del div: al
  // hacer textContent="" se destruye el DOM interno de Leaflet pero quedan vivos
  // sus manejadores de arrastre, y al tocar el mapa se cae con "offsetWidth null".
  if (elements.locationMap && !state.locationMap) elements.locationMap.textContent = "Cargando mapa...";
  showLocationPermissionHelp(false);

  const location = await getLocation();
  elements.locationButton.disabled = false;

  if (location.error || !location.latitud || !location.longitud) {
    state.currentLocation = null;
    elements.locationMap?.classList.remove("is-loading");
    elements.locationMap?.classList.remove("is-visible");
    if (elements.locationMap && !state.locationMap) elements.locationMap.textContent = "";

    if (location.error === "denied" || location.error === "unsupported") {
      elements.locationStatus.textContent = `${location.message} Sigue los pasos para habilitarlo.`;
      mostrarInstruccionesUbicacionDenegada();
    } else {
      elements.locationStatus.textContent = location.message || "No se pudo obtener la ubicacion. Toca 'Activar ubicacion' para reintentar.";
    }
    syncSubmitLockPorUbicacion();
    return null;
  }

  const point = findNearestOperationalPoint(location);
  state.currentLocation = { ...location, punto_operativo: point?.name || "" };
  elements.locationStatus.textContent = formatLocationStatus(state.currentLocation, point);
  if (elements.locationMap && !state.locationMap) elements.locationMap.textContent = "";
  renderLocationMap(location.latitud, location.longitud, location.precision);
  syncSubmitLockPorUbicacion();
  return state.currentLocation;
}

function findNearestOperationalPoint(location) {
  const points = Array.isArray(config.PUNTOS_OPERATIVOS) ? config.PUNTOS_OPERATIVOS : [];
  const validPoints = points
    .map((point) => ({
      name: point.nombre || point.name || "",
      latitud: Number(point.latitud ?? point.lat),
      longitud: Number(point.longitud ?? point.lng),
      radio: Number(point.radio_metros ?? point.radio ?? 200)
    }))
    .filter((point) => point.name && Number.isFinite(point.latitud) && Number.isFinite(point.longitud));

  if (!validPoints.length) return null;

  return validPoints
    .map((point) => ({
      ...point,
      distance: calculateDistanceMeters(location.latitud, location.longitud, point.latitud, point.longitud)
    }))
    .sort((a, b) => a.distance - b.distance)[0];
}

function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const earthRadius = 6371000;
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatLocationStatus(location, point) {
  const precision = location.precision ? `Precision ${Math.round(location.precision)} m.` : "";
  const coords = `Lat ${Number(location.latitud).toFixed(6)}, Lon ${Number(location.longitud).toFixed(6)}.`;
  if (!point) return `${coords} ${precision} Sin puntos operativos configurados.`;

  const distance = Math.round(point.distance);
  const inside = distance <= point.radio;
  return `${coords} ${precision} Punto mas cercano: ${point.name} a ${distance} m (${inside ? "dentro" : "fuera"} del radio).`;
}

const DUPLICADO_MINUTOS = 30;

// Devuelve la marca previa del MISMO sentido si esta a menos de 30 min (posible doble marca).
async function marcaDuplicadaReciente(colaboradorId, sentido, fecha, hora) {
  if (!colaboradorId) return null;
  const { data, error } = await supabaseClient
    .from("asistencias")
    .select("id,fecha,hora,sentido")
    .eq("colaborador_id", colaboradorId)
    .eq("sentido", sentido)
    .order("fecha", { ascending: false })
    .order("hora", { ascending: false })
    .limit(1);

  if (error || !data?.length) return null;

  const ultima = data[0];
  const horaAct = String(hora).length === 5 ? `${hora}:00` : String(hora).slice(0, 8);
  const tsUltima = new Date(`${ultima.fecha}T${String(ultima.hora).slice(0, 8)}`).getTime();
  const tsActual = new Date(`${fecha}T${horaAct}`).getTime();
  if (Number.isNaN(tsUltima) || Number.isNaN(tsActual)) return null;

  const diffMin = Math.abs(tsActual - tsUltima) / 60000;
  if (diffMin < DUPLICADO_MINUTOS) {
    return { ...ultima, diffMin: Math.round(diffMin) };
  }
  return null;
}

const MIN_MINUTOS_ENTRE_ENTRADA_Y_SALIDA = 60;

// Evita cerrar (SALIDA) demasiado pronto despues de la ENTRADA que se va a cerrar
// (toque accidental o confusion de sentido). Se revalida contra la base -no contra
// state.openEntrada- por si cambio despues de validar la cedula.
async function salidaMuyRecienteTrasEntrada(colaboradorId, fecha, hora) {
  if (!colaboradorId) return null;
  const { data, error } = await supabaseClient
    .from("asistencias")
    .select("id,fecha,hora,sentido")
    .eq("colaborador_id", colaboradorId)
    .eq("sentido", "entrada")
    .order("fecha", { ascending: false })
    .order("hora", { ascending: false })
    .limit(1);

  if (error || !data?.length) return null;

  const entrada = data[0];
  const horaAct = String(hora).length === 5 ? `${hora}:00` : String(hora).slice(0, 8);
  const tsEntrada = new Date(`${entrada.fecha}T${String(entrada.hora).slice(0, 8)}`).getTime();
  const tsActual = new Date(`${fecha}T${horaAct}`).getTime();
  if (Number.isNaN(tsEntrada) || Number.isNaN(tsActual)) return null;

  const diffMin = (tsActual - tsEntrada) / 60000;
  if (diffMin >= 0 && diffMin < MIN_MINUTOS_ENTRE_ENTRADA_Y_SALIDA) {
    return { ...entrada, diffMin: Math.round(diffMin) };
  }
  return null;
}

async function submitAttendance(event) {
  event.preventDefault();
  // Cerrojo sincrono contra doble click/Enter: sin esto, un segundo click mientras
  // el primero todavia esta validando (por ejemplo esperando el dialogo de cierre
  // de un turno anterior) dispara esta funcion dos veces en paralelo y puede
  // duplicar RPCs como cerrar_turno_automatico o abrir el dialogo de cierre dos veces.
  if (state.submittingMark || state.submitInFlight) {
    return;
  }
  state.submitInFlight = true;
  try {
  if (!requireOnline()) return;
  setMessage(elements.formMessage, "");
  clearBukResult();

  const dni = normalizeDni(elements.dniInput.value);
  const csvCollaborator = await findActiveCsvCollaborator(dni);

  if (!csvCollaborator) {
    setMessage(elements.formMessage, "Registro rechazado: la cedula no esta activa en la base.", "error");
    setWorkflowState("dni");
    return;
  }

  // La jornada del turno ya cumplida (entrada + salida) NO admite otra marca. Se
  // revalida contra la base y no contra el estado en pantalla, que puede estar viejo
  // si la pagina llevaba rato abierta o si alguien mas registro entre tanto.
  try {
    const { data: estado } = await supabaseClient.rpc("estado_turno_actual", {
      p_dni: dni, p_momento: momentoReporte()
    });
    if (estado?.ok && estado.existe && estado.completa) {
      state.turnoEstado = estado;
      renderProgramacionBanner();
      showAlertModal(
        "Jornada ya cumplida",
        `Este conductor ya registró la ENTRADA (${estado.entrada_real || "--:--"}) y la SALIDA `
        + `(${estado.salida_real || "--:--"}) de su turno ${estado.turno ?? ""} programado `
        + `(${estado.entrada_prog || "--:--"} a ${estado.salida_prog || "--:--"}). `
        + "Su jornada está cerrada y no se permite otra marca. "
        + "Si hay que corregir algo, hazlo desde Administración › Verificador de horarios."
      );
      setMessage(elements.formMessage,
        "Registro bloqueado: la jornada de este turno ya está cumplida.", "error");
      return;
    }
  } catch (e) {
    console.warn("No se pudo revalidar el estado del turno:", e?.message || e);
  }

  // Turno anterior sin cerrar: se corta aqui, antes de pedir foto y ubicacion, para
  // no hacerle recorrer todo el proceso a quien igual no va a poder registrar.
  //
  // Este bloque SOLO cierra el turno que se esta mostrando. Antes, si el cierre
  // quedaba bien, el codigo seguia de una vez con el resto de la funcion y
  // terminaba registrando la ENTRADA de hoy en el mismo click -el mensaje de exito
  // dice "Ahora registra la ENTRADA de hoy" pero en la practica ya la registraba
  // solo. Por eso ahora se retorna siempre: cerrado o no, hay que volver a darle a
  // "Registrar" para la entrada.
  if (state.nextSentido === "entrada" && state.openEntrada && state.cierrePendiente) {
    const cerrado = await ofrecerCierreTurnoAnterior(state.sentidoSegunProgramacion);
    if (!cerrado) {
      renderProgramacionBanner();
      elements.programacionBanner?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return;
  }

  if (!state.faceValidated || !state.compressedFile) {
    setMessage(elements.formMessage, "Primero toma la foto de evidencia.", "error");
    setWorkflowState("photo");
    return;
  }

  // Recordatorio: si NO digitaron el celular, confirmar que la marca se guardará
  // SIN enviar comprobante por WhatsApp (por si el conductor sí lo quería).
  const celularComprobante = elements.celularComprobanteInput?.value.trim() || "";
  if (!celularComprobante) {
    const continuar = await confirmGraphical(
      "¿Enviar comprobante por WhatsApp?",
      "No digitaste un número de celular, así que esta marca se guardará SIN enviar comprobante por WhatsApp. ¿Deseas continuar así o prefieres agregar el número?",
      "Registrar sin comprobante",
      "Agregar número"
    );
    if (!continuar) {
      elements.celularComprobanteInput?.focus();
      elements.celularComprobanteInput?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
  } else {
    // Red de seguridad: si el numero es nuevo y aun no se pregunto (por ejemplo
    // porque le dieron Registrar de una), se pregunta aqui antes de guardar la marca.
    await preguntarGuardarCelular();
  }

  if (!state.colaborador) {
    const ensuredCollaborator = await ensureLocalCollaborator(csvCollaborator);
    if (!ensuredCollaborator) return;
    state.colaborador = ensuredCollaborator;
  }

  if (state.isDriverCandidate) {
    // Sin programacion del dia el vehiculo NO se exige: la app no sabe cual le
    // corresponde (no hay de donde autocompletarlo) y quien registra tampoco tiene
    // como saberlo. Exigirlo dejaba al conductor sin poder marcar.
    const sinProgramacion = !turnoProgramadoActual();
    const selectedVehicle = getSelectedVehicle();

    if (!selectedVehicle?.m_id && !sinProgramacion) {
      setMessage(elements.formMessage, "Falta seleccionar el vehiculo. Escribe el interno o placa y elige una opcion de la lista.", "error");
      elements.vehicleInput.classList.add("invalid");
      elements.vehicleInput.focus();
      elements.vehicleInput.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (!elements.baseInput.value.trim() && !sinProgramacion) {
      setMessage(elements.formMessage, "Falta la base operativa del conductor.", "error");
      elements.baseInput.classList.add("invalid");
      elements.baseInput.focus();
      elements.baseInput.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    // Si el vehiculo no coincide con el programado se avisa (no bloquea).
    const seguirConVehiculo = await confirmarVehiculoProgramado();
    if (!seguirConVehiculo) {
      elements.vehicleInput.focus();
      elements.vehicleInput.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    // El driverId solo hace falta si va a haber asignacion en Sonar, o sea si hay
    // vehiculo. Sin vehiculo no se asigna nada y no tiene por que bloquear la marca.
    if (selectedVehicle?.m_id && !state.attendanceSonarDriver?.dr_id) {
      setMessage(elements.formMessage, "No se pudo preparar el driverId de Sonar para este conductor.", "error");
      return;
    }
  }

  // Ubicacion OBLIGATORIA para todos (antifraude): sin coordenadas no se registra.
  if (!state.currentLocation) {
    elements.locationSection?.classList.remove("hidden");
    const location = await captureCurrentLocation();
    if (!location) {
      setMessage(elements.formMessage, "La ubicacion es OBLIGATORIA para registrar. Activa el GPS y permite el acceso a la ubicacion, luego toca 'Activar ubicacion'.", "error");
      elements.locationSection?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
  }

  const sentidoConfirmado = await confirmarCoherenciaTurno(state.nextSentido);
  if (!sentidoConfirmado) {
    // Con turno anterior sin cerrar el mensaje ya lo puso ofrecerCierreTurnoAnterior:
    // decir "revisa el tipo de marca" ahi confundiria, porque el tipo es el correcto.
    if (!(state.cierrePendiente && state.openEntrada)) {
      setMessage(elements.formMessage, "Registro cancelado. Revisa el tipo de marca (entrada o salida) segun corresponda.", "");
    }
    return;
  }

  // Si la hora no concuerda con el horario programado del turno, se avisa (no bloquea).
  const seguirConHorario = await confirmarHorarioProgramado(sentidoConfirmado);
  if (!seguirConHorario) {
    setMessage(elements.formMessage, "Registro cancelado. Revisa la hora frente al horario programado.", "");
    return;
  }

  // Jornada de mas de 16 h: Buk la va a rechazar. Explicacion OBLIGATORIA.
  const seguirConJornada = await confirmarJornadaExtendida(sentidoConfirmado);
  if (!seguirConJornada) {
    setMessage(elements.formMessage,
      "Registro cancelado: una jornada de más de "
      + `${LIMITE_HORAS_JORNADA} h necesita explicación para poder registrarse.`, "error");
    return;
  }

  state.submittingMark = true;
  setBusy(elements.submitButton, true);
  elements.submitButton.classList.remove("attention");
  showProcess("Registrando asistencia", "Guardando foto, marca y envio a Buk/Ctrlit...");

  let bukAceptado = false;
  let marcaGuardadaLocal = false;

  try {
    await syncServerClock();
    const sentido = state.nextSentido;
    const now = getReportParts();
    if (!now.date || !now.time) {
      throw new Error("Selecciona fecha y hora de reporte.");
    }
    const colaboradorDni = state.colaborador.dni;

    // Anti-duplicados: no permitir la misma marca (entrada/salida) dos veces en < 30 min.
    const duplicada = await marcaDuplicadaReciente(state.colaborador.id, sentido, now.date, now.time);
    if (duplicada) {
      hideProcess();
      setNextActionNotice("");
      showAlertModal(
        "Posible marca duplicada",
        `Ya hay una ${sentido.toUpperCase()} registrada hace ${duplicada.diffMin} minuto(s) (${duplicada.fecha} ${String(duplicada.hora).slice(0, 5)}). Para evitar registros dobles no se permite otra ${sentido} en menos de ${DUPLICADO_MINUTOS} minutos.`
      );
      throw new Error(`No se registro: ya existe una ${sentido} hace ${duplicada.diffMin} min (evitando marca doble).`);
    }

    // Anti-error: no dejar registrar la SALIDA antes de que pase un tiempo minimo
    // desde la ENTRADA que va a cerrar (toque accidental o confusion del sentido).
    if (sentido === "salida") {
      const entradaReciente = await salidaMuyRecienteTrasEntrada(state.colaborador.id, now.date, now.time);
      if (entradaReciente) {
        hideProcess();
        setNextActionNotice("");
        showAlertModal(
          "Ya tienes tu entrada registrada",
          `Tu ENTRADA quedó registrada hace ${entradaReciente.diffMin} minuto(s) (${entradaReciente.fecha} ${String(entradaReciente.hora).slice(0, 5)}). `
          + `Debes esperar al menos ${MIN_MINUTOS_ENTRE_ENTRADA_Y_SALIDA} minutos antes de registrar la SALIDA.`
        );
        throw new Error(`No se registro: la entrada fue hace ${entradaReciente.diffMin} min (menos de ${MIN_MINUTOS_ENTRE_ENTRADA_Y_SALIDA} min).`);
      }
    }

    showProcess("Validando con Buk/Ctrlit", "Verificando que Buk acepte la marca antes de guardar...");

    let entradaParaCierre = null;
    let jornadaBuk;
    if (sentido === "salida") {
      if (state.openEntrada) {
        // Se permite cerrar el turno biometricamente sin importar su antiguedad.
        // Si Buk lo rechaza (p. ej. por exceso de horas), la marca queda guardada
        // como pendiente en la pestana "Rechazos Buk" (no se pierde).
        entradaParaCierre = state.openEntrada;
        jornadaBuk = state.openEntrada.jornada || state.openEntrada.fecha;
        console.log("[BUK] cerrando turno abierto", { entradaParaCierre, jornadaBuk });
      } else {
        throw new Error("No hay turno abierto: no se puede registrar una salida sin una entrada previa.");
      }
    } else {
      if (state.openEntrada) {
        throw new Error(`El colaborador ya tiene una entrada abierta del ${state.openEntrada.fecha} ${String(state.openEntrada.hora).slice(0,5)}. Registra primero la salida.`);
      }
      jornadaBuk = now.date;
    }

    showProcess("Validando con Buk/Ctrlit", "Consultando obra real del colaborador en Buk...");
    const { obraId: obraIdReal, lookup: colaboradorLookup } = await lookupObraIdDeColaborador(colaboradorDni);
    console.log("[BUK] lookup colaborador", { obraIdReal, colaboradorLookup });
    const obraIdAUsar = obraIdReal || BUK_OBRA_ID;

    const trazaBuk = [{ paso: "lookup_colaborador", lookup: colaboradorLookup, obra_id_resuelto: obraIdAUsar }];
    const payloadSalida = {
      obra_id: obraIdAUsar,
      dni_colaborador: colaboradorDni,
      jornada: jornadaBuk,
      fecha: now.date,
      hora: now.time,
      sentido
    };

    console.log("[BUK] enviando salida (intento 1)", payloadSalida);
    let { data: bukData, error: bukError } = await invocarBukConReintento(payloadSalida);
    console.log("[BUK] respuesta salida (intento 1)", { data: bukData, error: bukError });
    trazaBuk.push({ paso: "salida_intento_1", payload: payloadSalida, respuesta: bukData ?? null, transportError: bukError?.message ?? null });

    const debeReintentar =
      (bukError || !bukData?.ok) &&
      sentido === "salida" &&
      bukRespuestaMencionaEntradaPrevia(bukData) &&
      entradaParaCierre;

    console.log("[BUK] retry? ", {
      debeReintentar,
      bukOk: bukData?.ok,
      sentido,
      mencionaEntradaPrevia: bukRespuestaMencionaEntradaPrevia(bukData),
      entradaParaCierre
    });

    if (debeReintentar) {
      const entrada = entradaParaCierre;
      const horaEntrada = String(entrada.hora || "").slice(0, 8);
      const jornadaEntrada = entrada.jornada || entrada.fecha;
      showProcess(
        "Reenviando entrada a Buk",
        `Buk no tiene la entrada del ${entrada.fecha} ${horaEntrada.slice(0, 5)} (jornada ${jornadaEntrada}). Reenviandola antes de la salida...`
      );

      const payloadEntrada = {
        asistencia_id: entrada.id,
        obra_id: obraIdAUsar,
        dni_colaborador: colaboradorDni,
        jornada: jornadaEntrada,
        fecha: entrada.fecha,
        hora: horaEntrada,
        sentido: "entrada"
      };
      console.log("[BUK] reenviando entrada", payloadEntrada);
      const { data: entradaBuk, error: entradaBukError } = await invocarBukConReintento(payloadEntrada);
      console.log("[BUK] respuesta entrada", { data: entradaBuk, error: entradaBukError });
      trazaBuk.push({ paso: "reenvio_entrada", payload: payloadEntrada, respuesta: entradaBuk ?? null, transportError: entradaBukError?.message ?? null });

      if (!entradaBukError && entradaBuk?.ok) {
        showProcess("Reintentando salida en Buk", "Entrada aceptada. Enviando la salida nuevamente...");

        console.log("[BUK] enviando salida (intento 2 tras entrada OK)", payloadSalida);
        const reintento = await invocarBukConReintento(payloadSalida);
        console.log("[BUK] respuesta salida (intento 2)", reintento);
        trazaBuk.push({ paso: "salida_intento_2", payload: payloadSalida, respuesta: reintento.data ?? null, transportError: reintento.error?.message ?? null });
        bukData = reintento.data;
        bukError = reintento.error;
      } else {
        const detalle = entradaBuk?.error || entradaBukError?.message || "Buk no acepto la entrada.";
        setNextActionNotice(`No se pudo reenviar la entrada a Buk: ${detalle}. La salida se guardara como pendiente.`);
      }
    }

    showBukResult({ resultado_final: bukData || bukError, trazaBuk });

    // Politica: la marca DEBE quedar guardada en Supabase aunque Buk la rechace.
    // Si Buk rechaza, se guarda con enviado_buk=false y el detalle del error,
    // para que quede registrada y aparezca en la pestana "Rechazos Buk".
    const bukOk = !bukError && !!bukData?.ok;
    const bukErrorText = bukOk ? "" : (mejorErrorBuk(bukData) || bukError?.message || "Buk/Ctrlit rechazo la marca.");
    if (bukOk) {
      bukAceptado = true;
    } else {
      setNextActionNotice(`Buk rechazo la marca, pero se guardara en la base como pendiente. Detalle: ${bukErrorText}`);
    }

    const esMovil = state.deviceMode === "mobile";
    let photoPath = null;
    let fotoEliminarEn = null;
    let fotoWarning = "";

    // La foto se guarda SIEMPRE (incluido movil, ahora en version liviana).
    showProcess("Registrando asistencia", esMovil ? "Subiendo foto liviana y marca..." : "Guardando foto y marca...");
    photoPath = `asistencias/${now.year}/${now.month}/${now.day}/${colaboradorDni}-${sentido}-${Date.now()}.webp`;
    fotoEliminarEn = addDays(now.date, 15);

    const { error: uploadError } = await supabaseClient.storage
      .from(config.FOTO_BUCKET)
      .upload(photoPath, state.compressedFile, {
        contentType: "image/webp",
        upsert: false
      });

    if (uploadError) {
      // No abortamos: la marca debe quedar guardada aunque falle la subida de foto.
      photoPath = null;
      fotoEliminarEn = null;
      fotoWarning = `Foto no se pudo subir: ${uploadError.message || "error de almacenamiento"}`;
    }

    const location = state.currentLocation || await getLocation();
    const userObservation = elements.observacionInput.value.trim();
    const faceObservation = state.faceWarning ? `Validacion facial con advertencia: ${state.faceWarning}` : "";
    const mobileObservation = esMovil ? "Marca desde movil (foto liviana y ubicacion almacenadas)" : "";
    const selectedVehicle = getSelectedVehicle();
    const selectedVehicleLabel = getSelectedVehicleLabel();
    const driverObservation = state.isDriverCandidate
      ? `Conductor: vehiculo ${selectedVehicleLabel}; base ${elements.baseInput.value.trim()}; ubicacion ${elements.locationStatus.textContent}`
      : "";
    const origen = state.isAdmin
      ? "admin_form"
      : (esMovil ? "movil" : "web");
    const bukObservation = bukOk ? "" : `Buk rechazo la marca: ${bukErrorText}`;
    // La explicacion de la jornada extendida va tambien en la observacion, para que
    // se vea en los reportes de siempre y no solo en la pestaña de la novedad.
    const motivoJornadaObs = state.motivoJornadaExtendida
      ? `Jornada de ${state.horasJornadaExtendida} h (máx ${LIMITE_HORAS_JORNADA} h): ${state.motivoJornadaExtendida}`
      : "";
    const sentidoRevisadoObs = state.avisarAdminSentido
      ? "⚠ El colaborador indicó que el sistema sugirió mal el tipo de marca (ENTRADA/SALIDA): requiere revisión del administrador."
      : "";
    const payload = {
      colaborador_id: state.colaborador.id,
      obra_id: state.colaborador.obra_id,
      fecha: now.date,
      hora: now.time,
      jornada: jornadaBuk,
      sentido,
      foto_path: photoPath,
      foto_eliminar_en: fotoEliminarEn,
      latitud: location.latitud || null,
      longitud: location.longitud || null,
      vehiculo_reporte: state.isDriverCandidate ? selectedVehicleLabel : null,
      base_operativa: state.isDriverCandidate ? elements.baseInput.value.trim() : null,
      punto_operativo: location.punto_operativo || null,
      ubicacion_precision_m: location.precision || null,
      origen,
      registrado_por: state.user.id,
      observacion: [sentidoRevisadoObs, state.motivoDesfase, motivoJornadaObs, userObservation, faceObservation, driverObservation, mobileObservation, fotoWarning, bukObservation].filter(Boolean).join(" | ") || null,
      celular_comprobante: normalizarCelularCo(elements.celularComprobanteInput?.value)
        || elements.celularComprobanteInput?.value.trim() || null,
      enviado_buk: bukOk,
      buk_status: bukData?.status ?? null,
      buk_respuesta: { obra_id_usado: bukData?.obra_id_usado ?? null, intentos: bukData?.intentos ?? [], error: bukErrorText || null },
      buk_error: bukOk ? null : bukErrorText,
      buk_enviado_at: new Date().toISOString()
    };

    const { data: insertedAttendance, error: insertError } = await supabaseClient
      .from("asistencias")
      .insert(payload)
      .select("id")
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        // La marca ya existe en la base local: no hay inconsistencia con Buk.
        marcaGuardadaLocal = true;
        throw new Error(
          "Ya existe una marca identica para este colaborador en la misma hora. No se duplico."
        );
      }
      throw insertError;
    }

    marcaGuardadaLocal = true;

    // El trigger de la base ya creo la novedad de jornada extendida (si aplica):
    // aqui solo se le pone la explicacion que dio quien registro.
    if (state.motivoJornadaExtendida) {
      await explicarJornadaExcedida(insertedAttendance?.id, state.motivoJornadaExtendida);
    }

    let sonarData = null;
    if (state.isDriverCandidate && selectedVehicle?.m_id) {
      showProcess("Asignando conductor", "Enviando asignacion del conductor al vehiculo en Sonar...");
      const sonarDriver = state.attendanceSonarDriver || await findSonarDriverByDni(colaboradorDni);
      if (!sonarDriver?.dr_id) {
        sonarData = {
          ok: false,
          error: "No se encontro driverId de Sonar para esta cedula.",
          conductor: null,
          vehiculo: {
            m_id: selectedVehicle.m_id,
            interno: selectedVehicle.interno,
            placa: selectedVehicle.placa
          }
        };
      } else {
        const result = await invokeSonarAssignmentWebhook({
          mid: selectedVehicle.m_id,
          driverId: sonarDriver.dr_id
        });
        sonarData = {
          ok: result.ok,
          error: result.error,
          conductor: sonarDriver,
          vehiculo: {
            m_id: selectedVehicle.m_id,
            interno: selectedVehicle.interno,
            placa: selectedVehicle.placa
          },
          parsed: result.parsed,
          payload: result.payload
        };
      }
    }

    if (state.isDriverCandidate && sonarData && !sonarData?.ok) {
      const sonarDebug = [
        sonarData?.error || "error sin detalle",
        sonarData?.conductor?.dr_id ? `dr_id ${sonarData.conductor.dr_id}` : "",
        sonarData?.vehiculo?.m_id ? `mId ${sonarData.vehiculo.m_id}` : ""
      ].filter(Boolean).join(" | ");
      const bukParte = bukOk ? "" : ` Ademas, Buk rechazo la marca (queda pendiente): ${bukErrorText}.`;
      setMessage(elements.formMessage, `Asistencia guardada, pero Sonar no asigno el conductor: ${sonarDebug}.${bukParte}`, "error");
    } else if (!bukOk) {
      setMessage(
        elements.formMessage,
        `Marca GUARDADA en la base como pendiente. Buk/Ctrlit la rechazo: ${bukErrorText}. Queda registrada y aparece en la pestana "Rechazos Buk" para reenviar.`,
        "error"
      );
    } else {
      setMessage(elements.formMessage, "Asistencia registrada y enviada a Buk/Ctrlit.", "success");
    }

    const nombreResumen = state.csvCandidate?.nombre || state.colaborador?.nombre || "Colaborador";
    const cargoResumen = state.csvCandidate?.cargo || "";
    const baseResumen = elements.baseInput.value.trim();
    const turnoNocturno = sentido === "salida" && jornadaBuk !== now.date;
    const filasResumen = [
      ["Colaborador", nombreResumen],
      ["Cedula", colaboradorDni],
      ["Cargo", cargoResumen],
      ["Tipo de marca", sentido === "entrada" ? "ENTRADA" : "SALIDA"],
      ["Fecha", now.date],
      ["Hora", now.time.slice(0, 5)],
      ["Jornada", jornadaBuk],
      turnoNocturno ? ["Turno nocturno", `Cerro la jornada ${jornadaBuk}`] : null,
      state.isDriverCandidate ? ["Vehiculo", selectedVehicleLabel] : null,
      state.isDriverCandidate ? ["Base operativa", baseResumen] : null,
      state.isDriverCandidate && sonarData
        ? ["Asignacion Sonar", sonarData.ok ? "Asignado" : `Fallo: ${sonarData.error || "sin detalle"}`, !sonarData.ok]
        : null,
      ["Foto", photoPath ? "Guardada" : "No se pudo subir", !photoPath],
      ["Ubicacion", (location.latitud && location.longitud)
        ? `${Number(location.latitud).toFixed(5)}, ${Number(location.longitud).toFixed(5)}`
        : "SIN UBICACION", !(location.latitud && location.longitud)],
      ["Estado Buk", bukOk ? "Aceptada por Buk/Ctrlit" : `Rechazada (pendiente): ${bukErrorText}`, !bukOk]
    ].filter(Boolean);

    showRegistroModal({
      titulo: bukOk ? "Asistencia registrada" : "Marca guardada (pendiente de Buk)",
      subtitulo: bukOk
        ? "La marca se guardo y se envio a Buk/Ctrlit."
        : "La marca quedo guardada. Buk/Ctrlit la rechazo y quedo pendiente de reenvio.",
      ok: bukOk,
      filas: filasResumen
    });

    resetAttendanceForm(true);
    elements.dniInput.value = colaboradorDni;
    await loadLastAttendance(colaboradorDni);
    state.sentidoForzadoManual = false;
    state.motivoDesfase = "";
    state.motivoJornadaExtendida = "";
    state.nextSentido = getNextSentidoFromLastAttendance();
    // Si con esta marca la jornada quedo completa, el aviso lo debe reflejar de una.
    await cargarEstadoTurno(colaboradorDni);
  } catch (error) {
    const inconsistente = bukAceptado && !marcaGuardadaLocal;
    if (inconsistente) {
      // Buk ya recibio la marca pero no se pudo guardar en la base local.
      // NO se debe reintentar a ciegas: se duplicaria la marca en Buk/nomina.
      setNextActionNotice("");
      setMessage(
        elements.formMessage,
        `IMPORTANTE: la marca YA fue enviada y aceptada por Buk/Ctrlit, pero no se pudo guardar en la base local (${error.message || "error desconocido"}). NO vuelvas a registrar la asistencia para evitar duplicarla en nomina. Avisa a administracion con la cedula y la hora para completar el registro manualmente.`,
        "error"
      );
      showAlertModal(
        "Marca enviada a Buk, pendiente en base local",
        "La marca fue aceptada por Buk/Ctrlit pero no quedo guardada localmente. No la registres de nuevo (se duplicaria en nomina). Administracion debe completar el registro manualmente."
      );
    } else {
      setMessage(elements.formMessage, error.message || "No se pudo registrar la asistencia.", "error");
    }
    elements.submitButton.disabled = inconsistente || !state.faceValidated;
  } finally {
    state.submittingMark = false;
    hideProcess();
    // Solo re-habilitamos el reintento si Buk NO acepto la marca y hay ubicacion.
    if (state.faceValidated && !bukAceptado && state.currentLocation) {
      elements.submitButton.disabled = false;
      elements.submitButton.classList.add("attention");
    }
  }
  } finally {
    // Cierra el cerrojo sincrono del inicio de la funcion, sin importar por cual
    // de los tantos "return" tempranos se haya salido (turno pendiente, falta foto,
    // falta ubicacion, etc.): asi el siguiente click SIEMPRE puede volver a intentar.
    state.submitInFlight = false;
  }
}

async function ensureLocalCollaborator(csvCollaborator) {
  setMessage(elements.formMessage, "Creando registro local del colaborador...");

  const { data: obra, error: obraError } = await supabaseClient
    .from("obras")
    .select("id,nombre,obra_id_externo")
    .eq("obra_id_externo", BUK_OBRA_ID)
    .maybeSingle();

  if (obraError || !obra) {
    setMessage(elements.formMessage, "No existe la obra fija 39305 en Supabase.", "error");
    return null;
  }

  const { data: created, error: createError } = await supabaseClient
    .from("colaboradores")
    .insert({
      dni: csvCollaborator.cedula,
      nombre: csvCollaborator.nombre || `Colaborador ${csvCollaborator.cedula}`,
      empresa: csvCollaborator.empresa || null,
      especialidad: csvCollaborator.cargo || null,
      estado: "vinculado",
      obra_id: obra.id,
      puede_usar_app: true
    })
    .select("id,dni,nombre,empresa,contrato,especialidad,estado,obra_id,foto_referencia_path,rostro_enrolado,rostro_enrolado_at,obras(nombre,obra_id_externo)")
    .single();

  if (!createError) return created;

  // 23505 = unique_violation en "dni": esto solo pasa si state.colaborador quedo
  // en null (por ejemplo, un click en Registrar mientras la validacion de la
  // cedula todavia estaba en curso) pero el colaborador YA existia en la tabla.
  // No es un error real: se recupera el que ya esta creado en vez de bloquear
  // el registro con el error crudo de Postgres.
  if (createError.code === "23505") {
    const { data: existente, error: fetchError } = await supabaseClient
      .from("colaboradores")
      .select("id,dni,nombre,empresa,contrato,especialidad,estado,obra_id,foto_referencia_path,rostro_enrolado,rostro_enrolado_at,obras(nombre,obra_id_externo)")
      .eq("dni", csvCollaborator.cedula)
      .maybeSingle();
    if (existente) return existente;
    setMessage(elements.formMessage, fetchError?.message || "No se pudo recuperar el colaborador existente.", "error");
    return null;
  }

  setMessage(elements.formMessage, createError.message || "No se pudo crear el colaborador local.", "error");
  return null;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function resetAttendanceForm(preserveBukResult = false) {
  state.colaborador = null;
  state.csvCandidate = null;
  state.compressedFile = null;
  state.faceValidated = false;
  state.reportDateTouched = false;
  state.reportTimeTouched = false;
  state.lastEntrada = null;
  state.openEntrada = null;
  elements.attendanceForm.reset();
  elements.collaboratorBox.className = "result-box muted";
  elements.collaboratorBox.textContent = "Digita una cedula para validar si esta activa.";
  elements.previewBox.classList.add("hidden");
  hideDriverGreetingCard();
  state.avisarAdminSentido = false;
  setWorkflowState("dni");
  stopCamera();
  if (!preserveBukResult) clearBukResult();
}

async function loadTodayHistory() {
  elements.historyList.textContent = "Cargando...";

  const dni = normalizeDni(arguments[0] || elements.historyDniInput.value);
  if (!dni) {
    clearHistoryPanel();
    elements.historyList.textContent = "Digita una cedula para consultar sus registros.";
    return;
  }
  const startDate = elements.historyStartDateInput.value;
  const endDate = elements.historyEndDateInput.value;
  if (startDate && endDate && startDate > endDate) {
    elements.historyList.textContent = "La fecha inicial no puede ser mayor que la fecha final.";
    return;
  }

  const from = (state.historyPage - 1) * state.historyPageSize;
  const to = from + state.historyPageSize - 1;
  let query = supabaseClient
    .from("asistencias")
    .select(dni ? "id,fecha,hora,sentido,origen,observacion,enviado_buk,buk_status,latitud,longitud,foto_path,colaboradores!inner(dni,nombre)" : "id,fecha,hora,sentido,origen,observacion,enviado_buk,buk_status,latitud,longitud,foto_path,colaboradores(dni,nombre)")
    .order("fecha", { ascending: false })
    .order("hora", { ascending: false })
    .range(from, to);

  let countQuery = supabaseClient
    .from("asistencias")
    .select("id,colaboradores!inner(dni)", { count: "exact", head: true });

  if (dni) {
    query = query.eq("colaboradores.dni", dni);
    countQuery = countQuery.eq("colaboradores.dni", dni);
  }

  if (startDate) {
    query = query.gte("fecha", startDate);
    countQuery = countQuery.gte("fecha", startDate);
  }

  if (endDate) {
    query = query.lte("fecha", endDate);
    countQuery = countQuery.lte("fecha", endDate);
  }

  const [{ data, error }, { count, error: countError }] = await Promise.all([query, countQuery]);

  if (error || countError) {
    elements.historyList.textContent = "No se pudieron cargar los registros.";
    return;
  }

  const resultRows = data || [];
  const rows = dni ? resultRows.filter((item) => item.colaboradores?.dni === dni) : resultRows;
  state.historyTotal = count || 0;
  state.currentHistory = rows;
  renderHistorySummary(rows, dni);
  renderHistoryPagination();

  if (!rows.length) {
    elements.historyList.textContent = "Sin registros para esta cedula en el rango consultado.";
    return;
  }

  elements.historyList.innerHTML = historyItemsHtml(rows);
}

function historyItemsHtml(rows) {
  return rows.map((item) => {
    const origen = item.origen || "web";
    // Ocultamos el origen "movil_sin_foto" (no aporta al usuario).
    const mostrarOrigen = origen !== "movil_sin_foto" && origen !== "movil";
    const tieneCoords = item.latitud != null && item.longitud != null;
    const lat = tieneCoords ? Number(item.latitud).toFixed(6) : "";
    const lon = tieneCoords ? Number(item.longitud).toFixed(6) : "";
    const nombreItem = item.colaboradores?.nombre || "Sin nombre";
    const fotoPath = item.foto_path || "";
    const labelFoto = `${nombreItem} · ${String(item.sentido).toUpperCase()} · ${item.fecha} ${String(item.hora).slice(0, 5)}`;
    return `
    <article class="history-item">
      <div class="history-time">${escapeHtml(String(item.hora).slice(0, 5))}</div>
      <div class="history-main">
        <strong>
          ${escapeHtml(nombreItem)}
          <span class="pill ${escapeHtml(item.sentido)}">${escapeHtml(item.sentido)}</span>
        </strong>
        <div class="history-meta">
          <span>Cedula ${escapeHtml(item.colaboradores?.dni || "")}</span>
          <span>${escapeHtml(item.fecha)}</span>
          ${mostrarOrigen ? `<span>${escapeHtml(origen)}</span>` : ""}
          <span>Buk ${item.enviado_buk ? "OK" : escapeHtml(item.buk_status || "pendiente")}</span>
          ${tieneCoords ? `<a class="history-geo" href="https://www.google.com/maps?q=${lat},${lon}" target="_blank" rel="noopener">📍 ${lat}, ${lon}</a>` : ""}
          ${fotoPath
            ? `<button type="button" class="history-geo history-photo-btn" data-foto="${escapeHtml(fotoPath)}" data-label="${escapeHtml(labelFoto)}">📷 Ver foto</button>`
            : `<span>Sin foto</span>`}
        </div>
      </div>
    </article>
  `;
  }).join("");
}

// Carga los ultimos 20 registros (todos los colaboradores) al entrar a "Mis registros".
async function loadRecentHistory() {
  if (!supabaseClient) return;
  elements.historyList.textContent = "Cargando últimos registros...";
  const startDate = elements.historyStartDateInput.value;
  const endDate = elements.historyEndDateInput.value;

  let query = supabaseClient
    .from("asistencias")
    .select("id,fecha,hora,sentido,origen,observacion,enviado_buk,buk_status,latitud,longitud,foto_path,colaboradores(dni,nombre)")
    .order("fecha", { ascending: false })
    .order("hora", { ascending: false })
    .limit(20);
  if (startDate) query = query.gte("fecha", startDate);
  if (endDate) query = query.lte("fecha", endDate);

  const { data, error } = await query;
  if (error) {
    elements.historyList.textContent = "No se pudieron cargar los registros.";
    return;
  }

  const rows = data || [];
  state.currentHistory = rows;
  state.historyTotal = rows.length;
  state.historyPage = 1;
  elements.historySubtitle.textContent = "Últimos 20 registros (digita una cédula para filtrar)";
  elements.historySummary.classList.add("hidden");
  elements.historyPageLabel.textContent = "Últimos 20";
  elements.historyPrevPageButton.disabled = true;
  elements.historyNextPageButton.disabled = true;

  elements.historyList.innerHTML = rows.length ? historyItemsHtml(rows) : "";
  if (!rows.length) elements.historyList.textContent = "No hay registros en el rango.";
}

async function refreshCurrentHistory() {
  const dni = normalizeDni(elements.historyDniInput.value);
  if (!dni) {
    if (state.isAdmin) {
      await loadRecentHistory();
    } else {
      clearHistoryPanel();
      elements.historyList.textContent = "Digita una cedula para consultar sus registros.";
    }
    return;
  }
  if (arguments[0] !== "keep-page") state.historyPage = 1;
  await loadTodayHistory(dni);
  await loadLastAttendance(dni);
  renderHistorySummary(state.currentHistory, dni);
}

async function loadLastAttendance(dni) {
  const cleanDni = normalizeDni(dni);
  if (!cleanDni) {
    state.lastAttendance = null;
    return null;
  }

  const { data, error } = await supabaseClient
    .from("asistencias")
    .select("id,fecha,hora,jornada,sentido,origen,enviado_buk,buk_status,colaboradores!inner(dni,nombre)")
    .eq("colaboradores.dni", cleanDni)
    .gte("fecha", FECHA_CORTE_VALIDACIONES)
    .order("fecha", { ascending: false })
    .order("hora", { ascending: false })
    .limit(1);

  if (error) {
    state.lastAttendance = null;
    return null;
  }

  state.lastAttendance = data?.[0] || null;
  return state.lastAttendance;
}

function clearHistoryPanel() {
  state.currentHistory = [];
  state.lastAttendance = null;
  state.historyPage = 1;
  state.historyTotal = 0;
  elements.historySubtitle.textContent = "Digita una cedula para consultar";
  elements.historySummary.classList.add("hidden");
  elements.historyList.textContent = "Digita una cedula para ver sus registros de hoy.";
  renderHistoryPagination();
}

function renderHistorySummary(rows, dni) {
  if (!dni) {
    elements.historySummary.classList.add("hidden");
    elements.historySubtitle.textContent = "Digita una cedula para consultar";
    return;
  }

  const lastRecord = rows[0];
  const next = getNextSentidoFromLastAttendance();
  elements.historySubtitle.textContent = dni;
  elements.historyTotal.textContent = String(state.historyTotal || rows.length);
  elements.historyLast.textContent = lastRecord ? `${lastRecord.sentido} ${lastRecord.fecha} ${String(lastRecord.hora).slice(0, 5)}` : "--";
  elements.historyNext.textContent = next;
  elements.historySummary.classList.remove("hidden");
}

function renderHistoryPagination() {
  const totalPages = Math.max(1, Math.ceil((state.historyTotal || 0) / state.historyPageSize));
  if (state.historyPage > totalPages) state.historyPage = totalPages;
  elements.historyPageLabel.textContent = `Pagina ${state.historyPage} de ${totalPages}`;
  elements.historyPrevPageButton.disabled = state.historyPage <= 1 || state.historyTotal === 0;
  elements.historyNextPageButton.disabled = state.historyPage >= totalPages || state.historyTotal === 0;
}

function getNextSentidoFromLastAttendance() {
  const last = state.lastAttendance;
  if (!last) return "entrada";
  return last.sentido === "entrada" ? "salida" : "entrada";
}

function getOpenAttendanceInfo() {
  const last = state.lastAttendance;
  if (!last || last.sentido !== "entrada") return "";
  const today = getTodayParts().date;
  if (last.fecha === today) return "";
  return `Entrada abierta desde ${last.fecha} ${String(last.hora).slice(0, 5)}. Debe registrar salida.`;
}

function hideDriverGreetingCard() {
  state.identidadConfirmada = false;
  if (!elements.driverGreetingCard) return;
  elements.driverGreetingCard.classList.add("hidden");
  elements.driverGreetingCard.innerHTML = "";
}

// Tarjeta grande con el nombre (para que el conductor confirme que es el) y el
// sentido (ENTRADA/SALIDA) que va a registrar. Mientras no se confirme, actua
// como una barrera: no se habilita la camara ni los controles de marca (ver
// mostrarConfirmacionIdentidad / confirmarIdentidadYContinuar).
function renderDriverGreetingCard() {
  if (!elements.driverGreetingCard) return;
  const nombre = state.csvCandidate?.nombre || state.colaborador?.nombre || "";
  if (!nombre) {
    hideDriverGreetingCard();
    return;
  }

  const iniciales = nombre
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((parte) => parte[0])
    .join("")
    .toUpperCase();
  const dni = normalizeDni(elements.dniInput.value);
  const sentido = state.nextSentido === "salida" ? "salida" : "entrada";
  const confirmado = state.identidadConfirmada;

  elements.driverGreetingCard.className =
    `driver-greeting-card sentido-${sentido} ${confirmado ? "confirmado" : "pendiente"}`;

  let cuerpo;
  if (confirmado) {
    cuerpo = `
      <div class="driver-greeting-confirmed">
        <i data-lucide="check-circle-2"></i>
        <span>Confirmaste tu identidad. Continúa con la foto.</span>
      </div>
    `;
  } else {
    cuerpo = `
      <p class="driver-greeting-question">
        Verifica el nombre y el tipo de marca antes de continuar.
      </p>
      <div class="driver-greeting-actions">
        <button id="confirmIdentityYesButton" class="primary wide" type="button">
          <i data-lucide="check-circle-2"></i>
          Sí, soy yo · registrar mi ${sentido.toUpperCase()}
        </button>
        <button id="confirmIdentityNoButton" class="secondary wide" type="button">
          <i data-lucide="x-circle"></i>
          No soy yo
        </button>
      </div>
    `;
  }

  elements.driverGreetingCard.innerHTML = `
    <div class="driver-greeting-top">
      <div class="driver-avatar" aria-hidden="true">${escapeHtml(iniciales || "?")}</div>
      <div class="driver-greeting-body">
        <span class="driver-greeting-hello">${confirmado ? "Identidad confirmada" : "¿Eres tú?"}</span>
        <strong class="driver-greeting-name">${escapeHtml(nombre)}</strong>
        ${dni ? `<span class="driver-greeting-dni">Cédula ${escapeHtml(dni)}</span>` : ""}
      </div>
      <div class="sentido-big-badge">
        <i data-lucide="${sentido === "salida" ? "log-out" : "log-in"}"></i>
        <span>${confirmado ? "Registrando tu" : "Vas a registrar tu"} ${sentido.toUpperCase()}</span>
      </div>
    </div>
    ${cuerpo}
  `;
  elements.driverGreetingCard.classList.remove("hidden");
  if (window.lucide?.createIcons) window.lucide.createIcons();

  if (!confirmado) {
    $("#confirmIdentityYesButton")?.addEventListener("click", confirmarIdentidadYContinuar);
    $("#confirmIdentityNoButton")?.addEventListener("click", rechazarIdentidad);
  }
}

// Muestra la tarjeta de confirmacion pendiente justo despues de validar la
// cedula. La camara y los controles de marca quedan bloqueados (workflowStage
// sigue en "dni") hasta que el conductor confirme que es el y el sentido.
function mostrarConfirmacionIdentidad() {
  state.identidadConfirmada = false;
  renderDriverGreetingCard();
  if (elements.stepGuideText) {
    elements.stepGuideText.textContent = "Confirma que eres tú y el tipo de marca para continuar.";
  }
  setMessage(elements.formMessage, "Confirma tu identidad y el tipo de marca para continuar.", "success");
}

async function confirmarIdentidadYContinuar() {
  // Segunda confirmacion, aparte de "soy yo": el tipo de marca (ENTRADA/SALIDA) es
  // justo lo que mas se presta a error/toque accidental, asi que pide un tap extra
  // y explicito antes de abrir la camara.
  const sentido = state.nextSentido === "salida" ? "salida" : "entrada";
  const confirmaSentido = await confirmGraphical(
    "Confirma el tipo de marca",
    `Vas a registrar tu ${sentido.toUpperCase()}. ¿Es correcto?`,
    `Sí, es mi ${sentido.toUpperCase()}`,
    "No, revisar"
  );
  if (!confirmaSentido) {
    avisarAdminSentidoIncorrecto();
    return;
  }

  state.identidadConfirmada = true;
  renderDriverGreetingCard();
  setWorkflowState("photo");
  setMessage(elements.formMessage, state.isDriverCandidate
    ? "Identidad confirmada. Ubica el rostro dentro del recuadro para la validación biométrica."
    : "Identidad confirmada. Toma la foto de evidencia para continuar.", "success");
  await startCamera();
}

// El conductor indica que el nombre mostrado no es el suyo: se corta el flujo
// en vez de dejarlo seguir con la identidad de otra persona.
function rechazarIdentidad() {
  showAlertModal(
    "Verifica la cédula",
    "Si el nombre no corresponde contigo, revisa el número de cédula digitado o avisa al administrador. No continues con el registro de otra persona."
  );
  resetAttendanceForm();
  elements.dniInput.value = "";
  elements.dniInput.focus();
}

// Cuando el sentido sugerido no es el correcto no se le ofrece al conductor un
// atajo para forzarlo el mismo (ENTRADA con un turno abierto queda bloqueado en
// submitAttendance, y SALIDA sin turno abierto tambien; el "opuesto" al sugerido
// siempre es un callejon sin salida). En vez de eso se manda directo al selector
// manual (Entrada/Salida) de mas abajo, que ya tiene sus propios resguardos
// (turno sin cerrar, confirmacion, etc.), y la marca queda con nota para revisión:
// no se le da al conductor control sobre las horas, esas las valida un administrador.
function avisarAdminSentidoIncorrecto() {
  state.avisarAdminSentido = true;
  renderDriverGreetingCard();
  showAlertModal(
    "Quedará marcada para revisión",
    "Usa los botones ENTRADA/SALIDA de más abajo para elegir el que sepas que es correcto y continúa normalmente. "
    + "Tu marca se guardará con una nota para que el administrador la revise."
  );
  elements.markControls?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function renderSentidoSelector() {
  if (!elements.sentidoEntradaButton || !elements.sentidoSalidaButton) return;
  elements.sentidoEntradaButton.classList.toggle("active", state.nextSentido === "entrada");
  elements.sentidoSalidaButton.classList.toggle("active", state.nextSentido === "salida");

  // El tipo de marca lo decide el sistema (horario programado y, si no hay, la
  // ultima marca), pero se puede corregir confirmando: bloquearlo del todo obligaba
  // al operador a registrar el sentido equivocado cuando quedaba un turno sin cerrar.
  elements.sentidoEntradaButton.disabled = false;
  elements.sentidoSalidaButton.disabled = false;
  elements.sentidoEntradaButton.classList.remove("locked");
  elements.sentidoSalidaButton.classList.remove("locked");

  renderDriverGreetingCard();

  const suggested = getNextSentidoFromLastAttendance();
  if (!elements.sentidoSuggestion) return;
  if (!state.colaborador && !state.csvCandidate) {
    elements.sentidoSuggestion.textContent = "";
    return;
  }

  const prog = state.sentidoSegunProgramacion;
  const actual = state.nextSentido.toUpperCase();
  if (state.sentidoForzadoManual) {
    elements.sentidoSuggestion.textContent =
      `${actual} elegido a mano (el sistema sugería ${(prog?.sentido || suggested).toUpperCase()}).`;
  } else if (prog && prog.dist <= SENTIDO_PROG_MAX_MIN) {
    const horaRef = prog.sentido === "salida" ? prog.turno?.hora_salida : prog.turno?.hora_entrada;
    elements.sentidoSuggestion.textContent =
      `${actual} — según su turno programado de ${horaRef || "--:--"}. Puedes corregirlo si no corresponde.`;
  } else if (state.nextSentido === suggested) {
    elements.sentidoSuggestion.textContent = `Sugerido por la ultima marca: ${suggested}.`;
  } else {
    elements.sentidoSuggestion.textContent = `Estas registrando ${state.nextSentido} (sugerido era ${suggested}).`;
  }
}

// Cambio manual del sentido: se pide confirmacion porque contradice lo que el
// sistema dedujo del horario / la ultima marca, y queda anotado en la observacion.
async function cambiarSentidoManual(sentido) {
  if (sentido === state.nextSentido) return;

  // Con un turno pendiente por declarar, pasar a SALIDA a mano lo cerraria con la
  // hora de AHORA en vez de la real. Es la misma brecha, por otra puerta: se ofrece
  // la declaracion en su lugar.
  if (sentido === "salida" && state.cierrePendiente && state.openEntrada) {
    const c = state.cierrePendiente;
    const ok = await confirmGraphical(
      "Ese turno hay que declararlo",
      `La entrada abierta es del ${c.fecha} a las ${c.hora}. Si registras una SALIDA ahora, `
      + "ese turno quedaría cerrado con la hora de hoy y la jornada saldría descuadrada. "
      + "Declara a qué hora terminó de verdad y por qué no quedó la marca.",
      "Declarar la hora de salida",
      "Cancelar"
    );
    if (ok) {
      const cerrado = await ofrecerCierreTurnoAnterior(state.sentidoSegunProgramacion);
      if (cerrado) { setSentido("entrada"); }
    }
    return;
  }

  const prog = state.sentidoSegunProgramacion;
  const motivo = (prog && prog.dist <= SENTIDO_PROG_MAX_MIN)
    ? `Su turno programado indica ${prog.sentido.toUpperCase()}`
    : (state.openEntrada
        ? `Tiene un turno ABIERTO del ${state.openEntrada.fecha}`
        : "No tiene un turno abierto");
  const ok = await confirmGraphical(
    "Cambiar el tipo de marca",
    `${motivo}, pero vas a registrar una ${sentido.toUpperCase()}. `
    + "Hazlo solo si de verdad corresponde: un sentido equivocado descuadra la jornada y la nómina.",
    `Sí, registrar ${sentido.toUpperCase()}`,
    "Cancelar"
  );
  if (!ok) return;
  state.sentidoForzadoManual = true;
  setSentido(sentido);
}

function setSentido(sentido) {
  if (sentido !== "entrada" && sentido !== "salida") return;
  state.nextSentido = sentido;
  renderSentidoSelector();
  renderJornadaHint();
  renderProgramacionBanner();
}

function renderJornadaHint() {
  if (!elements.jornadaHint) return;
  if (state.nextSentido !== "salida" || !state.lastAttendance || state.lastAttendance.sentido !== "entrada") {
    elements.jornadaHint.classList.add("hidden");
    elements.jornadaHint.textContent = "";
    return;
  }
  const today = getTodayParts().date;
  const entradaFecha = state.lastAttendance.fecha;
  if (!entradaFecha || entradaFecha >= today) {
    elements.jornadaHint.classList.add("hidden");
    elements.jornadaHint.textContent = "";
    return;
  }
  const horaEntrada = String(state.lastAttendance.hora || "").slice(0, 5);
  elements.jornadaHint.textContent = `Cerrando turno nocturno: jornada ${entradaFecha} (entrada ${horaEntrada}).`;
  elements.jornadaHint.classList.remove("hidden");
}

async function notifyManualAdminExitWebhook(payload) {
  const url = config.MANUAL_ADMIN_EXIT_WEBHOOK_URL;
  if (!url) return;

  const explicacion =
    "Un administrador registro una salida manual desde el panel de administracion para cerrar el turno de un colaborador. " +
    "La salida se envio a Buk/Ctrlit usando la fecha real ingresada y la jornada del dia de la entrada.";

  const ahora = new Date();
  const horaAccion = ahora.toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  let horasTurnoAbierto = null;
  try {
    const tsEntrada = new Date(`${payload.entrada.fecha}T${String(payload.entrada.hora || "00:00:00").slice(0, 8)}`);
    const tsSalida = new Date(`${payload.salida.fecha}T${String(payload.salida.hora || "00:00:00").slice(0, 8)}`);
    const diffMs = tsSalida.getTime() - tsEntrada.getTime();
    if (Number.isFinite(diffMs) && diffMs > 0) {
      const totalMin = Math.round(diffMs / 60000);
      const dias = Math.floor(totalMin / 1440);
      const horas = Math.floor((totalMin % 1440) / 60);
      const minutos = totalMin % 60;
      horasTurnoAbierto = dias >= 1
        ? `${dias}d ${horas}h ${minutos}m`
        : `${horas}h ${minutos}m`;
    }
  } catch (_) { /* ignorar */ }

  const nombre = payload.colaboradorCsv?.nombre || payload.colaborador.nombre || null;
  const dni = payload.colaborador.dni;
  const novedad = `[ADMIN] Cierre manual del turno de ${nombre || "(sin nombre)"} (cedula ${dni}) | Turno abierto: ${horasTurnoAbierto || "n/d"} | Motivo: ${payload.motivo}`;

  const body = {
    tipo: "salida_manual_admin",
    explicacion,
    novedad,
    hora_accion: horaAccion,
    enviado_en: ahora.toISOString(),
    registrado_por: {
      user_id: state.user?.id ?? null,
      email: state.user?.email ?? null
    },
    colaborador: {
      id: payload.colaborador.id,
      dni,
      nombre,
      cargo: payload.colaboradorCsv?.cargo || null,
      empresa: payload.colaboradorCsv?.empresa || payload.colaborador.empresa || null,
      obra_id: payload.colaborador.obra_id || null
    },
    entrada_pendiente: {
      fecha: payload.entrada.fecha,
      hora: String(payload.entrada.hora || "").slice(0, 8)
    },
    salida_registrada: {
      asistencia_id: payload.asistenciaId,
      fecha: payload.salida.fecha,
      hora: payload.salida.hora,
      jornada_buk: payload.salida.jornada
    },
    horas_turno_abierto: horasTurnoAbierto,
    motivo: payload.motivo,
    buk: {
      ok: payload.bukOk,
      resultado: payload.bukResultado
    }
  };

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      mode: "no-cors"
    });
  } catch (error) {
    console.warn("No se pudo notificar webhook de salida manual del admin", error);
  }
}

function renderLastEntradaLabel(entrada) {
  if (!entrada) return 'Ultima entrada: <em>sin registros</em>';
  const hora = String(entrada.hora || "").slice(0, 5);
  const jornada = entrada.jornada && entrada.jornada !== entrada.fecha
    ? ` (jornada ${escapeHtml(entrada.jornada)})`
    : "";
  const bukTag = entrada.enviado_buk
    ? '<span style="color:#0a6b3b;font-weight:700">Buk OK</span>'
    : `<span style="color:#b3261e;font-weight:700">Buk rechazo (${escapeHtml(String(entrada.buk_status || "sin enviar"))})</span>`;
  return `Ultima entrada: <strong>${escapeHtml(entrada.fecha)} ${escapeHtml(hora)}</strong>${jornada} &middot; ${bukTag}`;
}

function renderTurnoEstadoLabel() {
  if (!state.openEntrada && !state.lastEntrada) {
    return 'Turno: <strong>sin marcas previas</strong>';
  }
  if (state.openEntrada) {
    const hora = String(state.openEntrada.hora || "").slice(0, 5);
    return `Turno: <strong style="color:#b35400">ABIERTO</strong> desde ${escapeHtml(state.openEntrada.fecha)} ${escapeHtml(hora)} - la proxima marca debe ser SALIDA`;
  }
  return 'Turno: <strong style="color:#0a6b3b">CERRADO</strong> - la proxima marca debe ser ENTRADA (jornada de hoy)';
}

function computeOpenEntrada() {
  if (state.lastAttendance?.sentido === "entrada") {
    state.openEntrada = state.lastAttendance;
  } else {
    state.openEntrada = null;
    // Sin turno abierto no queda nada pendiente por declarar: se levanta el bloqueo.
    state.cierrePendiente = null;
  }
}

function renderTurnoStatusBanner() {
  const banner = elements.turnoStatusBanner;
  if (!banner) return;

  if (!state.csvCandidate) {
    banner.className = "turno-status-banner hidden";
    banner.innerHTML = "";
    return;
  }

  const open = state.openEntrada;
  let clase, icon, texto;

  if (!open) {
    clase = "ok";
    icon = "check-circle-2";
    texto = "Sin turno abierto. La próxima marca es ENTRADA.";
  } else {
    const hora = String(open.hora || "").slice(0, 5);
    const today = getTodayParts().date;
    if (open.fecha === today) {
      clase = "warn";
      icon = "alert-triangle";
      texto = `Turno ABIERTO desde hoy ${hora}. La próxima marca debe ser SALIDA.`;
    } else {
      // Turno abierto de dias anteriores: no mostramos el letrero de alerta.
      banner.className = "turno-status-banner hidden";
      banner.innerHTML = "";
      return;
    }
  }

  banner.className = `turno-status-banner ${clase}`;
  banner.innerHTML = `<i data-lucide="${icon}"></i><span>${escapeHtml(texto)}</span>`;
  renderIcons();
}

async function confirmarCoherenciaTurno(sentido) {
  // Valida la coherencia del turno antes de registrar y, si hay conflicto,
  // muestra un modal explicando la situacion y ofreciendo la accion correcta.
  // Devuelve el sentido con el que continuar, o null si el usuario cancela.
  if (sentido === "entrada" && state.openEntrada) {
    // No se puede tener dos entradas abiertas. Hay que declarar el cierre del turno
    // viejo; si no lo hacen, la marca NO se registra. Antes se pasaba a SALIDA sola,
    // pero eso cerraba el turno de ayer con la hora de hoy: el error que perseguimos.
    const cerrado = await ofrecerCierreTurnoAnterior(state.sentidoSegunProgramacion);
    if (cerrado) return "entrada";
    if (!state.openEntrada) return "entrada";
    return null;
  }

  if (sentido === "salida" && !state.openEntrada) {
    const cambiar = await confirmGraphical(
      "No hay una entrada abierta",
      "Una SALIDA necesita una ENTRADA previa y este colaborador no tiene un turno abierto. ¿Quieres registrar una ENTRADA en su lugar?",
      "Sí, registrar entrada",
      "Cancelar"
    );
    if (cambiar) { setSentido("entrada"); return "entrada"; }
    return null;
  }

  return sentido;
}

async function loadOpenTurns() {
  if (!state.isAdmin) return;
  if (!requireOnline(elements.openTurnsStatus)) return;

  setBusy(elements.openTurnsReloadButton, true);
  elements.openTurnsStatus.textContent = "Cargando turnos abiertos...";
  elements.openTurnsBody.innerHTML = "";

  try {
    await ensureCsvLoaded();
    const { data, error } = await supabaseClient
      .from("asistencias")
      .select("id,fecha,hora,jornada,sentido,enviado_buk,buk_status,colaborador_id,colaboradores(dni,nombre)")
      .order("colaborador_id", { ascending: true })
      .order("fecha", { ascending: false })
      .order("hora", { ascending: false })
      .limit(2000);

    if (error) throw error;

    const latestPorColaborador = new Map();
    (data || []).forEach((mark) => {
      if (!latestPorColaborador.has(mark.colaborador_id)) {
        latestPorColaborador.set(mark.colaborador_id, mark);
      }
    });

    const abiertos = Array.from(latestPorColaborador.values())
      .filter((mark) => mark.sentido === "entrada")
      .sort((a, b) => {
        const tsA = new Date(`${a.fecha}T${String(a.hora).slice(0,8)}`).getTime();
        const tsB = new Date(`${b.fecha}T${String(b.hora).slice(0,8)}`).getTime();
        return tsA - tsB;
      });

    state.openTurns = abiertos;
    populateOpenTurnsCargoFilter();
    renderOpenTurns();
    renderOverdueTurns();
  } catch (error) {
    elements.openTurnsStatus.textContent = error.message || "No se pudieron cargar los turnos abiertos.";
  } finally {
    setBusy(elements.openTurnsReloadButton, false);
  }
}

const OVERDUE_HORAS = 15;

function getOverdueTurns() {
  const limite = Date.now() - OVERDUE_HORAS * 3600 * 1000;
  return (state.openTurns || []).filter((mark) => {
    const ts = new Date(`${mark.fecha}T${String(mark.hora).slice(0, 8)}`).getTime();
    return !Number.isNaN(ts) && ts < limite;
  });
}

function getOverdueDriverTurns() {
  return getOverdueTurns().filter((mark) => {
    const dni = mark.colaboradores?.dni || "";
    return isDriverCargo(getCargoForDni(dni));
  });
}

function renderOverdueTurns() {
  const rows = getOverdueTurns();
  const drivers = getOverdueDriverTurns();
  state.overdueDriversCount = drivers.length;
  refreshAlertsBadge();
  refreshOverdueDriversToast(drivers);
  if (!rows.length) {
    elements.overdueTurnsStatus.textContent = `Sin turnos abiertos hace mas de ${OVERDUE_HORAS} horas. Excelente.`;
    elements.overdueTurnsBody.innerHTML = "";
    return;
  }
  elements.overdueTurnsStatus.textContent = `${rows.length} colaborador(es) con turno vencido (>${OVERDUE_HORAS}h). Estos seguro necesitan cierre manual.`;

  const ahora = Date.now();
  elements.overdueTurnsBody.innerHTML = rows.map((mark) => {
    const entradaTs = new Date(`${mark.fecha}T${String(mark.hora).slice(0, 8)}`).getTime();
    const diffMs = ahora - entradaTs;
    const horas = Math.floor(diffMs / 3600000);
    const minutos = Math.floor((diffMs % 3600000) / 60000);
    const dias = Math.floor(horas / 24);
    const tiempoLabel = dias >= 1 ? `${dias}d ${horas % 24}h` : `${horas}h ${minutos}m`;
    const claseTiempo = dias >= 1 ? "turno-alerta-critica" : "turno-alerta-media";
    const dni = mark.colaboradores?.dni || "";
    const nombre = mark.colaboradores?.nombre || getDisplayNameForDni(dni) || "Sin nombre";
    const cargo = getCargoForDni(dni) || "Sin cargo";

    return `
      <tr data-mark-id="${escapeHtml(mark.id)}" data-dni="${escapeHtml(dni)}">
        <td>${escapeHtml(dni)}</td>
        <td>${escapeHtml(nombre)}</td>
        <td>${escapeHtml(cargo)}</td>
        <td>${escapeHtml(mark.fecha)} ${escapeHtml(String(mark.hora).slice(0, 5))}</td>
        <td class="${claseTiempo}">${escapeHtml(tiempoLabel)}</td>
      </tr>
    `;
  }).join("");
  renderIcons();
}

// Texto que se guarda en la observacion cuando el conductor usa "El sistema se
// equivocó, avisar al administrador" (ver avisarAdminSentidoIncorrecto). Se
// busca por un fragmento estable del mensaje, no por el texto completo, para
// no depender de que nadie mas lo edite despues.
const SENTIDO_REVISION_MARCADOR = "requiere revisión del administrador";
// La regla (y el flag en la observacion) se estrenaron el 2-sep-2026: nada
// anterior al 1-sep-2026 pudo haberla usado. Fecha fija, no ventana movil,
// igual que FECHA_CORTE_VALIDACIONES.
const SENTIDO_REVISION_DESDE = "2026-09-01";

async function loadSentidoRevisionMarks() {
  if (!state.isAdmin) return;
  try {
    await ensureCsvLoaded();
    const { data, error } = await supabaseClient
      .from("asistencias")
      .select("id,fecha,hora,sentido,observacion,colaboradores(dni,nombre)")
      .ilike("observacion", `%${SENTIDO_REVISION_MARCADOR}%`)
      .gte("fecha", SENTIDO_REVISION_DESDE)
      .order("fecha", { ascending: false })
      .order("hora", { ascending: false })
      .limit(200);
    if (error) throw error;
    state.sentidoRevisionRows = data || [];
  } catch (error) {
    console.warn("No se pudieron cargar las marcas con sentido a revisar:", error?.message || error);
    state.sentidoRevisionRows = [];
  }
  renderSentidoRevisionMarks();
}

function renderSentidoRevisionMarks() {
  if (!elements.sentidoRevisionStatus || !elements.sentidoRevisionBody) return;
  const rows = state.sentidoRevisionRows || [];
  state.sentidoRevisionCount = rows.length;
  refreshAlertsBadge();

  if (!rows.length) {
    elements.sentidoRevisionStatus.textContent =
      `Sin marcas con sentido a revisar desde el ${SENTIDO_REVISION_DESDE}.`;
    elements.sentidoRevisionBody.innerHTML = "";
    return;
  }
  elements.sentidoRevisionStatus.textContent =
    `${rows.length} marca(s) donde el conductor indicó que el sentido sugerido era incorrecto.`;

  elements.sentidoRevisionBody.innerHTML = rows.map((mark) => {
    const dni = mark.colaboradores?.dni || "";
    const nombre = mark.colaboradores?.nombre || getDisplayNameForDni(dni) || "Sin nombre";
    const cargo = getCargoForDni(dni) || "Sin cargo";
    return `
      <tr data-mark-id="${escapeHtml(mark.id)}" data-dni="${escapeHtml(dni)}">
        <td>${escapeHtml(dni)}</td>
        <td>${escapeHtml(nombre)}</td>
        <td>${escapeHtml(cargo)}</td>
        <td>${escapeHtml(mark.fecha)}</td>
        <td>${escapeHtml(String(mark.hora).slice(0, 5))}</td>
        <td><span class="pill ${escapeHtml(mark.sentido)}">${escapeHtml(mark.sentido)}</span></td>
      </tr>
    `;
  }).join("");
  renderIcons();
}

function refreshOverdueDriversToast(drivers) {
  const toast = elements.overdueDriversToast;
  if (!toast) return;
  if (!state.isAdmin || !Array.isArray(drivers) || drivers.length === 0) {
    toast.classList.add("hidden");
    return;
  }

  const idsActuales = drivers.map((mark) => mark.id).sort().join("|");
  if (state.overdueToastDismissed && idsActuales === state.overdueToastDismissedIds.join("|")) {
    toast.classList.add("hidden");
    return;
  }
  if (idsActuales !== state.overdueToastDismissedIds.join("|")) {
    state.overdueToastDismissed = false;
    state.overdueToastDismissedIds = [];
  }

  const ahora = Date.now();
  const items = drivers.slice(0, 8).map((mark) => {
    const ts = new Date(`${mark.fecha}T${String(mark.hora).slice(0, 8)}`).getTime();
    const diffMs = ahora - ts;
    const horas = Math.floor(diffMs / 3600000);
    const minutos = Math.floor((diffMs % 3600000) / 60000);
    const dias = Math.floor(horas / 24);
    const tiempoLabel = dias >= 1 ? `${dias}d ${horas % 24}h` : `${horas}h ${minutos}m`;
    const dni = mark.colaboradores?.dni || "";
    const nombre = mark.colaboradores?.nombre || getDisplayNameForDni(dni) || "Sin nombre";
    return `
      <li>
        <span class="overdue-toast-driver">${escapeHtml(nombre)}</span>
        <span class="overdue-toast-meta">${escapeHtml(dni)} &middot; entrada ${escapeHtml(mark.fecha)} ${escapeHtml(String(mark.hora).slice(0, 5))}</span>
        <span class="overdue-toast-time">${escapeHtml(tiempoLabel)}</span>
      </li>
    `;
  }).join("");

  const restantes = drivers.length - Math.min(drivers.length, 8);
  elements.overdueDriversToastTitle.textContent =
    `${drivers.length} conductor(es) con turno > ${OVERDUE_HORAS} h`;
  elements.overdueDriversToastList.innerHTML = items + (restantes > 0
    ? `<li class="overdue-toast-more">+${restantes} mas</li>`
    : "");
  toast.classList.remove("hidden");
  renderIcons();
}

function dismissOverdueDriversToast() {
  state.overdueToastDismissed = true;
  state.overdueToastDismissedIds = getOverdueDriverTurns().map((mark) => mark.id).sort();
  elements.overdueDriversToast?.classList.add("hidden");
}

function exportOverdueTurnsToCSV() {
  const rows = getOverdueTurns();
  if (!rows.length) {
    setMessage(elements.overdueTurnsStatus, "No hay turnos vencidos para exportar.", "error");
    return;
  }
  exportTurnsToCsv(rows, `turnos-vencidos-${stampForFile()}.csv`);
  setMessage(elements.overdueTurnsStatus, `${rows.length} fila(s) exportadas a CSV.`, "success");
}

function stampForFile() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
}

function exportTurnsToCsv(rows, filename) {
  const ahora = Date.now();
  const header = ["Cedula", "Nombre", "Cargo", "Empresa", "Fecha entrada", "Hora entrada", "Jornada", "Tiempo abierto", "Buk"];
  const escapeCsv = (val) => {
    const s = String(val ?? "");
    if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lineas = [header.join(";")];
  rows.forEach((mark) => {
    const dni = mark.colaboradores?.dni || "";
    const nombre = mark.colaboradores?.nombre || getDisplayNameForDni(dni) || "";
    const entradaTs = new Date(`${mark.fecha}T${String(mark.hora).slice(0, 8)}`).getTime();
    const diffMs = ahora - entradaTs;
    const horas = Math.floor(diffMs / 3600000);
    const minutos = Math.floor((diffMs % 3600000) / 60000);
    const dias = Math.floor(horas / 24);
    const tiempoLabel = dias >= 1 ? `${dias}d ${horas % 24}h` : `${horas}h ${minutos}m`;
    const buk = mark.enviado_buk ? "Buk OK" : `Buk: ${mark.buk_status || "sin enviar"}`;
    lineas.push([
      dni,
      nombre,
      getCargoForDni(dni) || "",
      getEmpresaForDni(dni) || "",
      mark.fecha,
      String(mark.hora).slice(0, 5),
      mark.jornada || mark.fecha,
      tiempoLabel,
      buk
    ].map(escapeCsv).join(";"));
  });
  triggerCsvDownload(lineas.join("\r\n"), filename);
}

function triggerCsvDownload(contenido, filename) {
  const csv = "﻿" + contenido;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function populateOpenTurnsCargoFilter() {
  const seleccionadosPrevios = new Set(
    Array.from(elements.openTurnsCargoFilter.selectedOptions || []).map((o) => o.value)
  );
  const cargos = Array.from(new Set(
    (state.openTurns || [])
      .map((mark) => getCargoForDni(mark.colaboradores?.dni))
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  elements.openTurnsCargoFilter.innerHTML = cargos.map((cargo) => `
    <option value="${escapeHtml(cargo)}" ${seleccionadosPrevios.has(cargo) ? "selected" : ""}>${escapeHtml(cargo)}</option>
  `).join("");
}

function getSelectedOpenTurnsCargos() {
  return Array.from(elements.openTurnsCargoFilter.selectedOptions || []).map((o) => o.value);
}

function renderOpenTurns() {
  const all = state.openTurns || [];
  if (!all.length) {
    elements.openTurnsStatus.textContent = "No hay turnos abiertos. Todos los colaboradores cerraron su entrada.";
    elements.openTurnsBody.innerHTML = "";
    return;
  }

  const query = (elements.openTurnsSearchInput?.value || "").trim().toLowerCase();
  const queryDni = normalizeDni(elements.openTurnsSearchInput?.value || "");
  const cargosSeleccionados = getSelectedOpenTurnsCargos();

  const rows = all.filter((mark) => {
    const dni = mark.colaboradores?.dni || "";
    const nombre = (mark.colaboradores?.nombre || getDisplayNameForDni(dni) || "").toLowerCase();
    const cargo = getCargoForDni(dni);

    if (cargosSeleccionados.length && !cargosSeleccionados.includes(cargo)) return false;
    if (query) {
      const matchTexto = nombre.includes(query);
      const matchDni = queryDni && normalizeDni(dni).includes(queryDni);
      if (!matchTexto && !matchDni) return false;
    }
    return true;
  });

  elements.openTurnsStatus.textContent = rows.length === all.length
    ? `${rows.length} colaborador(es) con turno abierto.`
    : `${rows.length} de ${all.length} turnos abiertos (filtrado).`;

  const ahora = Date.now();
  elements.openTurnsBody.innerHTML = rows.map((mark) => {
    const entradaTs = new Date(`${mark.fecha}T${String(mark.hora).slice(0,8)}`).getTime();
    const diffMs = ahora - entradaTs;
    const horas = Math.floor(diffMs / 3600000);
    const minutos = Math.floor((diffMs % 3600000) / 60000);
    const dias = Math.floor(horas / 24);
    let tiempoLabel;
    let claseTiempo;
    if (dias >= 1) {
      tiempoLabel = `${dias}d ${horas % 24}h`;
      claseTiempo = "turno-alerta-critica";
    } else if (horas >= 12) {
      tiempoLabel = `${horas}h ${minutos}m`;
      claseTiempo = "turno-alerta-media";
    } else {
      tiempoLabel = `${horas}h ${minutos}m`;
      claseTiempo = "turno-alerta-ok";
    }

    const dni = mark.colaboradores?.dni || "";
    const nombre = mark.colaboradores?.nombre || getDisplayNameForDni(dni) || "Sin nombre";
    const cargo = getCargoForDni(dni) || "Sin cargo";

    return `
      <tr data-mark-id="${escapeHtml(mark.id)}" data-dni="${escapeHtml(dni)}">
        <td>${escapeHtml(dni)}</td>
        <td>${escapeHtml(nombre)}</td>
        <td>${escapeHtml(cargo)}</td>
        <td>${escapeHtml(mark.fecha)} ${escapeHtml(String(mark.hora).slice(0,5))}</td>
        <td class="${claseTiempo}">${escapeHtml(tiempoLabel)}</td>
      </tr>
    `;
  }).join("");
  renderIcons();
}

function getEmpresaForDni(dni) {
  const csvRow = state.csvRows.find((row) => normalizeDni(row.cedula) === normalizeDni(dni));
  return csvRow?.empresa || "";
}

function exportOpenTurnsToCSV() {
  const all = state.openTurns || [];
  if (!all.length) {
    setMessage(elements.openTurnsStatus, "No hay turnos abiertos para exportar.", "error");
    return;
  }

  const query = (elements.openTurnsSearchInput?.value || "").trim().toLowerCase();
  const queryDni = normalizeDni(elements.openTurnsSearchInput?.value || "");
  const cargosSeleccionados = getSelectedOpenTurnsCargos();

  const rows = all.filter((mark) => {
    const dni = mark.colaboradores?.dni || "";
    const nombre = (mark.colaboradores?.nombre || getDisplayNameForDni(dni) || "").toLowerCase();
    const cargo = getCargoForDni(dni);
    if (cargosSeleccionados.length && !cargosSeleccionados.includes(cargo)) return false;
    if (query) {
      const matchTexto = nombre.includes(query);
      const matchDni = queryDni && normalizeDni(dni).includes(queryDni);
      if (!matchTexto && !matchDni) return false;
    }
    return true;
  });

  if (!rows.length) {
    setMessage(elements.openTurnsStatus, "El filtro actual no tiene resultados para exportar.", "error");
    return;
  }

  const ahora = Date.now();
  const header = [
    "Cedula",
    "Nombre",
    "Cargo",
    "Empresa",
    "Fecha entrada",
    "Hora entrada",
    "Jornada",
    "Tiempo abierto",
    "Buk"
  ];

  const escapeCsv = (val) => {
    const s = String(val ?? "");
    if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lineas = [header.join(";")];
  rows.forEach((mark) => {
    const dni = mark.colaboradores?.dni || "";
    const nombre = mark.colaboradores?.nombre || getDisplayNameForDni(dni) || "";
    const cargo = getCargoForDni(dni) || "";
    const empresa = getEmpresaForDni(dni) || "";
    const entradaTs = new Date(`${mark.fecha}T${String(mark.hora).slice(0, 8)}`).getTime();
    const diffMs = ahora - entradaTs;
    const horas = Math.floor(diffMs / 3600000);
    const minutos = Math.floor((diffMs % 3600000) / 60000);
    const dias = Math.floor(horas / 24);
    const tiempoLabel = dias >= 1 ? `${dias}d ${horas % 24}h` : `${horas}h ${minutos}m`;
    const bukLabel = mark.enviado_buk ? "Buk OK" : `Buk: ${mark.buk_status || "sin enviar"}`;

    lineas.push([
      dni,
      nombre,
      cargo,
      empresa,
      mark.fecha,
      String(mark.hora).slice(0, 5),
      mark.jornada || mark.fecha,
      tiempoLabel,
      bukLabel
    ].map(escapeCsv).join(";"));
  });

  const csv = "﻿" + lineas.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `turnos-abiertos-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);

  setMessage(elements.openTurnsStatus, `${rows.length} fila(s) exportadas a CSV.`, "success");
}

function confirmGraphical(title, text, acceptLabel = "Confirmar", cancelLabel = "Cancelar") {
  return new Promise((resolve) => {
    elements.confirmTitle.textContent = title;
    elements.confirmText.textContent = text;
    elements.confirmAccept.textContent = acceptLabel;
    elements.confirmCancel.textContent = cancelLabel;
    elements.confirmOverlay.classList.remove("hidden");

    const cleanup = () => {
      elements.confirmOverlay.classList.add("hidden");
      elements.confirmAccept.removeEventListener("click", onAccept);
      elements.confirmCancel.removeEventListener("click", onCancel);
    };
    const onAccept = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };

    elements.confirmAccept.addEventListener("click", onAccept);
    elements.confirmCancel.addEventListener("click", onCancel);
  });
}

// Motivos frecuentes por los que una marca no cuadra con el horario programado.
// Se ofrecen como botones para no obligar a escribir, pero se puede detallar a mano.
const MOTIVOS_DESFASE = [
  "Estaba en el taller",
  "Vehículo varado en ruta",
  "Relevo llegó tarde",
  "Demora por tráfico o novedad en vía",
  "Apoyo a otro turno",
  "Olvidó marcar a tiempo"
];

// Pide el MOTIVO de un desfase y lo devuelve como texto, o null si se cancela.
// Es obligatorio: sin motivo no se registra, para que la novedad quede explicada.
// `motivos` permite cambiar la lista de sugerencias segun el tipo de novedad.
function pedirMotivoDesfase(titulo, texto, motivos = MOTIVOS_DESFASE) {
  return new Promise((resolve) => {
    const ov = elements.motivoOverlay;
    if (!ov) { resolve(""); return; }   // sin modal en el DOM: no se bloquea el registro

    elements.motivoTitle.textContent = titulo;
    elements.motivoText.textContent = texto;
    elements.motivoInput.value = "";
    setMessage(elements.motivoError, "");
    elements.motivoOpciones.innerHTML = motivos.map((m) =>
      `<button type="button" class="motivo-chip">${escapeHtml(m)}</button>`).join("");
    ov.classList.remove("hidden");
    setTimeout(() => elements.motivoInput.focus(), 50);

    const onChip = (event) => {
      const chip = event.target.closest(".motivo-chip");
      if (!chip) return;
      // El chip llena el campo: queda editable por si quieren detallar mas.
      elements.motivoInput.value = chip.textContent;
      setMessage(elements.motivoError, "");
      elements.motivoInput.focus();
    };
    const cleanup = () => {
      ov.classList.add("hidden");
      elements.motivoOpciones.removeEventListener("click", onChip);
      elements.motivoAccept.removeEventListener("click", onAccept);
      elements.motivoCancel.removeEventListener("click", onCancel);
      elements.motivoInput.removeEventListener("keydown", onKey);
    };
    const onAccept = () => {
      const val = elements.motivoInput.value.trim();
      if (val.length < 4) {
        setMessage(elements.motivoError, "Escribe el motivo o elige uno de la lista.", "error");
        elements.motivoInput.focus();
        return;
      }
      cleanup();
      resolve(val);
    };
    const onCancel = () => { cleanup(); resolve(null); };
    const onKey = (event) => {
      if (event.key === "Enter") { event.preventDefault(); onAccept(); }
    };

    elements.motivoOpciones.addEventListener("click", onChip);
    elements.motivoAccept.addEventListener("click", onAccept);
    elements.motivoCancel.addEventListener("click", onCancel);
    elements.motivoInput.addEventListener("keydown", onKey);
  });
}

async function loadLastEntradaForDni(dni) {
  const cleanDni = normalizeDni(dni);
  if (!cleanDni) {
    state.lastEntrada = null;
    return null;
  }
  const { data, error } = await supabaseClient
    .from("asistencias")
    .select("id,fecha,hora,jornada,sentido,enviado_buk,buk_status,colaboradores!inner(dni,nombre)")
    .eq("colaboradores.dni", cleanDni)
    .eq("sentido", "entrada")
    .gte("fecha", FECHA_CORTE_VALIDACIONES)
    .order("fecha", { ascending: false })
    .order("hora", { ascending: false })
    .limit(1);
  if (error) {
    state.lastEntrada = null;
    return null;
  }
  state.lastEntrada = data?.[0] || null;
  return state.lastEntrada;
}

async function marcarEstadoBukEnAsistencia(asistenciaId, bukOk, bukData, bukError) {
  if (!asistenciaId) return;
  const bukErrorText = bukOk
    ? null
    : (mejorErrorBuk(bukData) || bukError?.message || "Buk/Ctrlit rechazo la marca.");
  try {
    await supabaseClient
      .from("asistencias")
      .update({
        enviado_buk: !!bukOk,
        buk_status: bukData?.status ?? null,
        buk_error: bukErrorText,
        buk_enviado_at: new Date().toISOString()
      })
      .eq("id", asistenciaId);
  } catch (error) {
    // La marca ya quedo guardada; si no se pudo actualizar el estado Buk, no abortamos.
    console.warn("[BUK] no se pudo actualizar estado de la asistencia", error);
  }
}

// Reintenta la llamada a la funcion Edge de Buk cuando la falla es de RED/transporte
// (p.ej. "Failed to send a request to the Edge Function": el fetch ni siquiera llego
// a responder), no cuando Buk SI respondio y rechazo la marca por una regla de
// negocio (esas no se arreglan reintentando, se reintenta exactamente el mismo error).
async function invocarBukConReintento(payload, maxIntentos = 3) {
  let intento = 0;
  let resultado = { data: null, error: null };
  while (intento < maxIntentos) {
    intento += 1;
    resultado = await supabaseClient.functions.invoke("enviar-asistencia-buk", { body: payload });
    if (resultado.data) return resultado;
    if (intento < maxIntentos) {
      await new Promise((resolve) => setTimeout(resolve, 900 * intento));
    }
  }
  return resultado;
}

async function lookupObraIdDeColaborador(dni) {
  try {
    const { data, error } = await supabaseClient.functions.invoke("consultar-colaborador-buk", {
      body: { dni_colaborador: dni }
    });
    if (error || !data?.ok) {
      console.warn("[BUK] lookup colaborador fallo", { error, data });
      return { obraId: null, lookup: data || { error: error?.message || "sin respuesta" } };
    }
    return { obraId: data.obra_id_principal || data.obra_ids?.[0] || null, lookup: data };
  } catch (error) {
    console.warn("[BUK] lookup colaborador excepcion", error);
    return { obraId: null, lookup: { error: error?.message || "excepcion en lookup" } };
  }
}

async function findEntradaToCloseSalida(dni, salidaFecha, salidaHora) {
  const cleanDni = normalizeDni(dni);
  if (!cleanDni) return null;

  const diaAnterior = addDays(salidaFecha, -1);

  const { data, error } = await supabaseClient
    .from("asistencias")
    .select("id,fecha,hora,jornada,sentido,colaboradores!inner(dni)")
    .eq("colaboradores.dni", cleanDni)
    .eq("sentido", "entrada")
    .in("fecha", [salidaFecha, diaAnterior])
    .order("fecha", { ascending: false })
    .order("hora", { ascending: false })
    .limit(20);

  if (error || !Array.isArray(data)) return null;

  const salidaHoraNorm = String(salidaHora || "").length === 5 ? `${salidaHora}:00` : salidaHora;
  const salidaTs = new Date(`${salidaFecha}T${salidaHoraNorm}`).getTime();
  if (Number.isNaN(salidaTs)) return null;

  return data.find((row) => {
    const horaNorm = String(row.hora || "").slice(0, 8);
    const ts = new Date(`${row.fecha}T${horaNorm}`).getTime();
    return !Number.isNaN(ts) && ts < salidaTs;
  }) || null;
}

// Saca el error MAS significativo de la respuesta de Buk. La función Edge
// reintenta con una obra de respaldo (ej. 39306) que no pertenece al colaborador,
// y ese intento devuelve "no pertenece al recinto...", que TAPA el motivo real
// (por ejemplo "Ya existe una marca de entrada"). Aquí priorizamos el motivo real.
function mejorErrorBuk(bukData) {
  if (!bukData) return null;
  const intentos = Array.isArray(bukData.intentos) ? bukData.intentos : [];
  const errores = intentos.map((i) => i?.error || i?.respuesta?.error).filter(Boolean).map(String);
  const esRuido = (e) => /no pertenece al recinto|obra_id\).*empresa|pertenece al recinto/i.test(e);
  const real =
    errores.find((e) => /ya existe una marca/i.test(e)) ||
    errores.find((e) => !esRuido(e)) ||
    (bukData.error && !esRuido(String(bukData.error)) ? bukData.error : null) ||
    errores[0] ||
    bukData.error ||
    null;
  return real ? String(real) : null;
}

function bukRespuestaMencionaEntradaPrevia(bukData) {
  if (!bukData) return false;
  const textos = [
    bukData?.error,
    bukData?.respuesta?.error,
    ...(Array.isArray(bukData?.intentos) ? bukData.intentos.map((i) => i?.error || i?.respuesta?.error) : [])
  ].filter(Boolean).map(String);
  return textos.some((t) => /no existe una marca de entrada previa/i.test(t));
}

function computeJornadaForMark(sentido, fechaMarca, lastEntradaFecha) {
  if (sentido !== "salida") return fechaMarca;
  const lastFecha = lastEntradaFecha
    ?? (state.lastAttendance?.sentido === "entrada" ? state.lastAttendance.fecha : null);
  if (lastFecha && lastFecha < fechaMarca) return lastFecha;
  return fechaMarca;
}

// Nombre historico ("Csv") de cuando la base de colaboradores activos venia de un
// Google Sheets publicado. Ahora se lee de employees (activo = true); se dejo el
// nombre de la funcion y de state.csvRows/csvCandidate para no tocar los ~15
// lugares del archivo que ya consumen esa forma de datos {cedula,nombre,estado,
// cargo,empresa,vehiculo,ruta}.
async function loadCollaboratorsCsv() {
  if (!requireOnline(elements.csvStatus)) return;
  elements.csvStatus.textContent = "Cargando base...";
  elements.csvTableBody.innerHTML = "";

  const { data, error } = await supabaseClient
    .from("employees")
    .select("cedula,nombre,cargo,vehiculo_asociado,ruta")
    .eq("activo", true);

  if (error) {
    elements.csvStatus.textContent = `No se pudo cargar la base de colaboradores: ${error.message}`;
    return;
  }

  state.csvRows = (data || []).map((row) => ({
    cedula: normalizeCsvText(row.cedula).replace(/[^\dA-Za-z]/g, ""),
    nombre: normalizeCsvText(row.nombre),
    estado: "ACTIVO",
    cargo: normalizeCsvText(row.cargo),
    empresa: "",
    vehiculo: normalizeCsvText(row.vehiculo_asociado),
    ruta: normalizeCsvText(row.ruta)
  }));
  state.csvLoaded = true;
  renderCsvTable();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);

  const headers = rows.shift()?.map(normalizeCsvHeader) || [];
  return rows.map((values) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = values[index]?.trim() || "";
    });
    return record;
  });
}

function normalizeCsvHeader(header) {
  return String(header || "")
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function getCsvValue(row, names) {
  const normalizedNames = names.map(normalizeCsvHeader);
  for (const name of normalizedNames) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name] || "";
  }
  return "";
}

function normalizeCsvText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeCsvRow(row) {
  return {
    cedula: normalizeCsvText(getCsvValue(row, ["CEDULA", "CÉDULA"])).replace(/[^\dA-Za-z]/g, ""),
    nombre: normalizeCsvText(getCsvValue(row, ["NOMBRE COMPLETO"])),
    estado: normalizeCsvText(getCsvValue(row, ["ESTADO"])),
    cargo: normalizeCsvText(getCsvValue(row, ["CARGO FUNCIONARIO", "CARGO"])),
    empresa: normalizeCsvText(getCsvValue(row, ["EMPRESA"])),
    vehiculo: normalizeCsvText(getCsvValue(row, ["VEHICULO_ASOCIADO", "VEHÍCULO_ASOCIADO", "VEHICULO ASOCIADO"])),
    ruta: normalizeCsvText(getCsvValue(row, ["RUTA"]))
  };
}

async function ensureCsvLoaded() {
  if (!state.csvLoaded) await loadCollaboratorsCsv();
}

async function findActiveCsvCollaborator(dni) {
  await ensureCsvLoaded();
  const cleanDni = normalizeDni(dni).replace(/[^\dA-Za-z]/g, "");
  return state.csvRows.find((row) => normalizeDni(row.cedula).replace(/[^\dA-Za-z]/g, "") === cleanDni) || null;
}

function renderCsvTable() {
  const query = elements.csvSearchInput.value.trim().toLowerCase();
  const filtered = state.csvRows.filter((row) => {
    if (!query) return true;
    return [row.cedula, row.nombre, row.estado, row.cargo, row.empresa, row.vehiculo, row.ruta]
      .some((value) => String(value).toLowerCase().includes(query));
  });

  elements.csvStatus.textContent = `${filtered.length} de ${state.csvRows.length} colaboradores activos`;
  elements.csvTableBody.innerHTML = filtered.slice(0, 300).map((row) => `
    <tr>
      <td>${escapeHtml(row.cedula)}</td>
      <td>${escapeHtml(row.nombre)}</td>
      <td class="status-active">${escapeHtml(row.estado)}</td>
      <td>${escapeHtml(row.cargo)}</td>
      <td>${escapeHtml(row.empresa)}</td>
      <td>${escapeHtml(row.vehiculo)}</td>
      <td>${escapeHtml(row.ruta)}</td>
      <td><button class="mini-button" type="button" data-use-dni="${escapeHtml(row.cedula)}">Usar</button></td>
    </tr>
  `).join("");

  if (filtered.length > 300) {
    elements.csvStatus.textContent += " - mostrando primeros 300";
  }
}

function useCsvDni(dni) {
  elements.dniInput.value = dni;
  showTab("register");
  buscarColaborador();
}

/* ==========================================================================
   Administracion > Perfil sociodemografico (tablas employees + perfil_sociodemografico)
   ========================================================================== */

const PERFIL_SOCIO_CAMPOS = [
  "tipo_identificacion", "fecha_nacimiento", "sexo", "estado_civil", "grado_escolaridad",
  "composicion_familiar", "estrato_socioeconomico", "lugar_residencia", "barrio",
  "medio_desplazamiento", "raza", "tipo_sangre", "turno_trabajo", "tipo_vinculacion",
  "fecha_ingreso", "conduce", "tipo_vehiculo_conduce", "anios_experiencia_conduccion",
  "personas_a_cargo", "cabeza_familia", "tipo_vivienda", "talla_camisa", "talla_pantalon",
  "talla_calzado", "eps", "arl", "fondo_pension", "caja_compensacion", "direccion_residencia"
];

// Se hacen 2 consultas por separado (en vez de un embed de PostgREST) para no
// depender de que la relacion employees -> perfil_sociodemografico se detecte
// como "a uno" (con FK unica) y no como arreglo; el cruce se hace aqui por employee_id.
async function loadPerfilSociodemografico() {
  if (!state.isAdmin) return;
  if (!requireOnline(elements.perfilSocioStatus)) return;

  setBusy(elements.reloadPerfilSocioButton, true);
  elements.perfilSocioStatus.textContent = "Cargando...";
  setMessage(elements.perfilSocioMessage, "");

  try {
    const [empRes, perfilRes] = await Promise.all([
      supabaseClient
        .from("employees")
        .select("id,nombre,cedula,cargo,area,activo,numero_interno,vehiculo_asociado,ruta,base,telefono,foto_url,salario,fecha_salida,created_at")
        .order("nombre", { ascending: true }),
      supabaseClient.from("perfil_sociodemografico").select("*")
    ]);

    if (empRes.error) {
      elements.perfilSocioStatus.textContent = "No se pudo cargar la base de colaboradores.";
      setMessage(elements.perfilSocioMessage, empRes.error.message || "Error consultando employees.", "error");
      return;
    }
    if (perfilRes.error) {
      setMessage(elements.perfilSocioMessage, `No se pudo cargar el perfil sociodemografico: ${perfilRes.error.message || ""}`, "error");
    }

    const perfilPorEmployee = new Map();
    (perfilRes.data || []).forEach((p) => perfilPorEmployee.set(p.employee_id, p));

    state.perfilSocioRows = (empRes.data || []).map((row) => ({
      ...row,
      perfil: perfilPorEmployee.get(row.id) || null
    }));
    state.perfilSocioLoaded = true;
    renderPerfilSocioTable();
  } finally {
    setBusy(elements.reloadPerfilSocioButton, false);
  }
}

function getFilteredPerfilSocioRows() {
  const q = (elements.perfilSocioSearchInput?.value || "").trim().toLowerCase();
  const qDni = normalizeDni(elements.perfilSocioSearchInput?.value || "");
  return (state.perfilSocioRows || []).filter((row) => {
    if (!q && !qDni) return true;
    const matchName = (row.nombre || "").toLowerCase().includes(q);
    const matchDni = qDni && normalizeDni(row.cedula || "").includes(qDni);
    return matchName || matchDni;
  });
}

function perfilSocioCompletitud(perfil) {
  if (!perfil) return { llenos: 0, total: PERFIL_SOCIO_CAMPOS.length };
  const llenos = PERFIL_SOCIO_CAMPOS.filter((campo) => {
    const v = perfil[campo];
    return v !== null && v !== undefined && String(v).trim() !== "";
  }).length;
  return { llenos, total: PERFIL_SOCIO_CAMPOS.length };
}

function renderPerfilSocioTable() {
  const rows = getFilteredPerfilSocioRows();
  elements.perfilSocioStatus.textContent = state.perfilSocioRows.length
    ? `${rows.length} de ${state.perfilSocioRows.length} colaborador(es)`
    : "Sin colaboradores para mostrar.";

  elements.perfilSocioBody.innerHTML = rows.map((row) => {
    const { llenos, total } = perfilSocioCompletitud(row.perfil);
    const completo = !!row.perfil && llenos === total;
    const tagClase = completo ? "badge-complete" : "badge-pending";
    const tagTexto = !row.perfil ? "Sin perfil" : (completo ? "Completo" : `${llenos}/${total}`);
    return `
      <tr>
        <td>${escapeHtml(row.cedula || "")}</td>
        <td>${escapeHtml(row.nombre || "")}</td>
        <td>${escapeHtml(row.cargo || "")}</td>
        <td class="${row.activo ? "status-active" : ""}">${row.activo ? "Activo" : "Inactivo"}</td>
        <td><span class="perfil-socio-tag ${tagClase}">${escapeHtml(tagTexto)}</span></td>
        <td><button class="mini-button" type="button" data-ver-perfil-socio="${escapeHtml(row.id)}">Ver detalle</button></td>
      </tr>
    `;
  }).join("");
  renderIcons();
}

function formatearValorPerfil(v) {
  if (v === null || v === undefined || v === "") return "--";
  return String(v);
}

function formatearMonedaCop(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "--";
  return n.toLocaleString("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
}

function calcularEdadDesdeFecha(fechaNacimiento) {
  if (!fechaNacimiento) return "--";
  const nac = new Date(`${String(fechaNacimiento).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(nac.getTime())) return "--";
  const hoy = new Date();
  let edad = hoy.getFullYear() - nac.getFullYear();
  const m = hoy.getMonth() - nac.getMonth();
  if (m < 0 || (m === 0 && hoy.getDate() < nac.getDate())) edad -= 1;
  return `${edad} años`;
}

function calcularAntiguedadDesdeFecha(fechaIngreso) {
  if (!fechaIngreso) return "--";
  const ini = new Date(`${String(fechaIngreso).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(ini.getTime())) return "--";
  const hoy = new Date();
  let meses = (hoy.getFullYear() - ini.getFullYear()) * 12 + (hoy.getMonth() - ini.getMonth());
  if (hoy.getDate() < ini.getDate()) meses -= 1;
  if (meses < 0) meses = 0;
  if (meses < 12) return `${meses} mes${meses === 1 ? "" : "es"}`;
  const anios = Math.floor(meses / 12);
  const restoMeses = meses % 12;
  return restoMeses ? `${anios} a ${restoMeses} m` : `${anios} años`;
}

function seccionPerfilSocioHtml(titulo, campos) {
  const llenos = campos.filter(([, valor]) => valor !== null && valor !== undefined && String(valor).trim() !== "");
  const tag = llenos.length === campos.length
    ? `<span class="perfil-socio-tag badge-complete">Completo</span>`
    : `<span class="perfil-socio-tag badge-pending">${campos.length - llenos.length} pendiente(s)</span>`;
  return `
    <div class="perfil-socio-section">
      <div class="perfil-socio-section-head">
        <strong>${escapeHtml(titulo)}</strong>
        ${tag}
      </div>
      <div class="perfil-socio-grid">
        ${campos.map(([etiqueta, valor]) => `
          <div class="perfil-socio-field">
            <span>${escapeHtml(etiqueta)}</span>
            <strong>${escapeHtml(formatearValorPerfil(valor))}</strong>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function siNoOVacio(v) {
  if (v === null || v === undefined) return null;
  return v ? "Si" : "No";
}

function abrirDetallePerfilSocio(employeeId) {
  const row = (state.perfilSocioRows || []).find((r) => r.id === employeeId);
  if (!row || !elements.perfilSocioDetailOverlay) return;
  const p = row.perfil || {};

  const iniciales = (row.nombre || "")
    .split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join("").toUpperCase();

  elements.perfilSocioDetailBody.innerHTML = `
    <div class="perfil-socio-header">
      <div class="perfil-socio-avatar" aria-hidden="true">${escapeHtml(iniciales || "?")}</div>
      <div class="perfil-socio-header-body">
        <h3>${escapeHtml(row.nombre || "")}</h3>
        <p>CC ${escapeHtml(row.cedula || "")} · ${escapeHtml(row.cargo || "Sin cargo")} · ${escapeHtml(row.area || "Sin área")}</p>
      </div>
      <div class="perfil-socio-badges">
        <span class="perfil-socio-tag ${row.activo ? "badge-complete" : "badge-pending"}">${row.activo ? "Activo" : "Inactivo"}</span>
        <span class="perfil-socio-tag ${row.perfil ? "badge-complete" : "badge-pending"}">${row.perfil ? "Perfil registrado" : "Sin perfil"}</span>
      </div>
    </div>

    <div class="perfil-socio-stats">
      <div class="perfil-socio-stat"><strong>${escapeHtml(formatearValorPerfil(p.fecha_ingreso))}</strong><span>Fecha de ingreso</span></div>
      <div class="perfil-socio-stat"><strong>${escapeHtml(calcularAntiguedadDesdeFecha(p.fecha_ingreso || row.created_at))}</strong><span>Antigüedad</span></div>
      <div class="perfil-socio-stat"><strong>${escapeHtml(calcularEdadDesdeFecha(p.fecha_nacimiento))}</strong><span>Edad</span></div>
      <div class="perfil-socio-stat"><strong>${escapeHtml(formatearMonedaCop(row.salario))}</strong><span>Salario</span></div>
    </div>

    <div class="perfil-socio-stats">
      <div class="perfil-socio-stat"><strong>${escapeHtml(formatearValorPerfil(row.numero_interno))}</strong><span>Vehículo interno</span></div>
      <div class="perfil-socio-stat"><strong>${escapeHtml(formatearValorPerfil(row.ruta))}</strong><span>Ruta</span></div>
      <div class="perfil-socio-stat"><strong>${escapeHtml(formatearValorPerfil(row.base))}</strong><span>Base</span></div>
    </div>

    ${seccionPerfilSocioHtml("Datos personales", [
      ["Tipo de identificación", p.tipo_identificacion],
      ["Sexo", p.sexo],
      ["Estado civil", p.estado_civil],
      ["Grado de escolaridad", p.grado_escolaridad],
      ["Grupo étnico", p.raza],
      ["Tipo de sangre", p.tipo_sangre]
    ])}

    ${seccionPerfilSocioHtml("Composición familiar", [
      ["Composición familiar", p.composicion_familiar],
      ["Personas a cargo", p.personas_a_cargo],
      ["¿Es cabeza de familia?", siNoOVacio(p.cabeza_familia)]
    ])}

    ${seccionPerfilSocioHtml("Vivienda y ubicación", [
      ["Estrato socioeconómico", p.estrato_socioeconomico],
      ["Lugar de residencia", p.lugar_residencia],
      ["Barrio", p.barrio],
      ["Dirección", p.direccion_residencia],
      ["Tipo de vivienda", p.tipo_vivienda],
      ["Medio de desplazamiento", p.medio_desplazamiento]
    ])}

    ${seccionPerfilSocioHtml("Salud y seguridad social", [
      ["EPS", p.eps],
      ["ARL", p.arl],
      ["Fondo de pensión", p.fondo_pension],
      ["Caja de compensación", p.caja_compensacion]
    ])}

    ${seccionPerfilSocioHtml("Dotación", [
      ["Talla camisa", p.talla_camisa],
      ["Talla pantalón", p.talla_pantalon],
      ["Talla calzado", p.talla_calzado]
    ])}

    ${seccionPerfilSocioHtml("Conducción y vinculación", [
      ["¿Conduce?", siNoOVacio(p.conduce)],
      ["Tipo de vehículo que conduce", p.tipo_vehiculo_conduce],
      ["Años de experiencia", p.anios_experiencia_conduccion],
      ["Tipo de vinculación", p.tipo_vinculacion],
      ["Turno de trabajo", p.turno_trabajo]
    ])}

    ${p.observaciones ? `
      <div class="perfil-socio-section">
        <div class="perfil-socio-section-head"><strong>Observaciones</strong></div>
        <p style="margin:0;color:var(--muted);">${escapeHtml(p.observaciones)}</p>
      </div>
    ` : ""}
  `;

  elements.perfilSocioDetailOverlay.classList.remove("hidden");
  renderIcons();
}

function cerrarDetallePerfilSocio() {
  elements.perfilSocioDetailOverlay?.classList.add("hidden");
}

async function loadAdminMarks() {
  if (!state.isAdmin) return;
  if (!requireOnline(elements.adminMarksStatus)) return;

  await ensureCsvLoaded();
  const desde = (elements.adminDateFromInput.value || "").trim();
  const hasta = (elements.adminDateToInput.value || "").trim();

  if (desde && hasta && desde > hasta) {
    elements.adminMarksStatus.textContent = "El rango de fechas es invalido (Desde > Hasta).";
    return;
  }

  elements.adminMarksStatus.textContent = "Cargando marcas...";

  const conRango = Boolean(desde || hasta);
  const PAGE = 1000;
  const TOPE = conRango ? 20000 : 1000;
  let acumulado = [];
  let offset = 0;

  while (offset < TOPE) {
    let query = supabaseClient
      .from("asistencias")
      .select("id,fecha,hora,sentido,origen,observacion,enviado_buk,buk_status,colaboradores(dni,nombre)")
      .order("fecha", { ascending: false })
      .order("hora", { ascending: false });

    if (desde) query = query.gte("fecha", desde);
    if (hasta) query = query.lte("fecha", hasta);
    query = query.range(offset, offset + PAGE - 1);

    elements.adminMarksStatus.textContent = `Cargando marcas... (${acumulado.length})`;
    const { data, error } = await query;
    if (error) {
      elements.adminMarksStatus.textContent = "No se pudieron cargar las marcas.";
      return;
    }
    const batch = data || [];
    acumulado = acumulado.concat(batch);
    if (batch.length < PAGE) break;
    offset += PAGE;
    if (!conRango) break;
  }

  state.adminMarks = acumulado;
  populateAdminCargoFilter();
  state.adminPage = 1;
  renderAdminMarks();
}

function renderAdminMarks() {
  const nameQuery = elements.adminNameSearchInput.value.trim().toLowerCase();
  const dniQuery = normalizeDni(elements.adminDniSearchInput.value);
  const desde = (elements.adminDateFromInput.value || "").trim();
  const hasta = (elements.adminDateToInput.value || "").trim();
  const selectedCargos = getSelectedAdminCargos();
  const rows = buildAdminJourneys(state.adminMarks).filter((item) => {
    const dni = item.dni || "";
    const name = item.nombre || getDisplayNameForDni(dni);
    const cargo = getCargoForDni(dni);

    if (nameQuery && !name.toLowerCase().includes(nameQuery)) return false;
    if (dniQuery && !normalizeDni(dni).includes(dniQuery)) return false;
    if (desde || hasta) {
      const fechas = [item.fecha, item.salidaFecha].filter(Boolean);
      const dentro = fechas.some((f) => (!desde || f >= desde) && (!hasta || f <= hasta));
      if (!dentro) return false;
    }
    if (selectedCargos.length && !selectedCargos.includes(cargo)) return false;
    return true;
  });

  state.adminFilteredMarks = rows;
  const totalPages = Math.max(1, Math.ceil(rows.length / state.adminPageSize));
  if (state.adminPage > totalPages) state.adminPage = totalPages;
  const start = (state.adminPage - 1) * state.adminPageSize;
  const pageRows = rows.slice(start, start + state.adminPageSize);

  elements.adminMarksStatus.textContent = `${rows.length} jornadas (${state.adminMarks.length} marcas)`;
  elements.adminPageLabel.textContent = `Página ${state.adminPage} de ${totalPages}`;
  elements.adminPrevPageButton.disabled = state.adminPage <= 1;
  elements.adminNextPageButton.disabled = state.adminPage >= totalPages;
  elements.adminMarksBody.innerHTML = pageRows.map((item) => `
    <tr>
      <td>${escapeHtml(item.fecha)}</td>
      <td>${escapeHtml(item.dni || "")}</td>
      <td>${escapeHtml(item.nombre || "")}</td>
      <td>${renderJourneyMark(item.entrada, "entrada")}</td>
      <td>${renderJourneyMark(item.salida, "salida")}</td>
      <td>${escapeHtml(item.tiempo || "")}</td>
      <td>${escapeHtml(item.observacion || "")}</td>
    </tr>
  `).join("");
}

function buildAdminJourneys(marks) {
  const byDni = new Map();

  marks.forEach((mark) => {
    const dni = mark.colaboradores?.dni || "";
    if (!dni) return;
    if (!byDni.has(dni)) byDni.set(dni, []);
    byDni.get(dni).push(mark);
  });

  const journeys = [];
  byDni.forEach((items, dni) => {
    const sorted = [...items].sort((a, b) => compareMarkDateTime(a, b));
    let openEntry = null;

    sorted.forEach((mark) => {
      if (mark.sentido === "entrada") {
        if (openEntry) journeys.push(createAdminJourney(dni, openEntry, null));
        openEntry = mark;
        return;
      }

      if (mark.sentido === "salida") {
        if (openEntry) {
          journeys.push(createAdminJourney(dni, openEntry, mark));
          openEntry = null;
        } else {
          journeys.push(createAdminJourney(dni, null, mark));
        }
      }
    });

    if (openEntry) journeys.push(createAdminJourney(dni, openEntry, null));
  });

  return journeys.sort((a, b) => {
    const bTime = `${b.salidaFecha || b.fecha}T${b.salida?.hora || b.entrada?.hora || "00:00:00"}`;
    const aTime = `${a.salidaFecha || a.fecha}T${a.salida?.hora || a.entrada?.hora || "00:00:00"}`;
    return bTime.localeCompare(aTime);
  });
}

function createAdminJourney(dni, entrada, salida) {
  const nombre = getDisplayNameForDni(dni, entrada?.colaboradores?.nombre || salida?.colaboradores?.nombre);
  const fecha = entrada?.fecha || salida?.fecha || "";
  const salidaFecha = salida?.fecha || "";
  const observacion = [formatMarkNote(entrada), formatMarkNote(salida)].filter(Boolean).join(" | ");

  return {
    dni,
    nombre,
    fecha,
    salidaFecha,
    entrada,
    salida,
    tiempo: calculateJourneyDuration(entrada, salida),
    observacion
  };
}

function compareMarkDateTime(a, b) {
  return `${a.fecha}T${a.hora}`.localeCompare(`${b.fecha}T${b.hora}`);
}

function renderJourneyMark(mark, type) {
  if (!mark) {
    return `<span class="journey-missing">${type === "entrada" ? "Sin entrada" : "Pendiente"}</span>`;
  }

  const date = type === "salida" && mark.fecha ? ` · ${escapeHtml(mark.fecha)}` : "";
  const origin = mark.origen ? ` · ${escapeHtml(mark.origen)}` : "";
  const delBtn = HABILITAR_ELIMINAR_MARCAS && mark.id
    ? `<button type="button" class="journey-del" data-del-id="${escapeHtml(String(mark.id))}"
         data-del-label="${escapeHtml(`${type} ${String(mark.hora).slice(0, 5)}${mark.fecha ? " del " + mark.fecha : ""}`)}"
         title="Eliminar marca (prueba)" aria-label="Eliminar marca">🗑</button>`
    : "";
  return `
    <div class="journey-mark">
      <span class="pill ${escapeHtml(type)}">${escapeHtml(String(mark.hora).slice(0, 5))}</span>
      <small>${date}${origin}</small>
      ${delBtn}
    </div>
  `;
}

function formatMarkNote(mark) {
  if (!mark?.observacion) return "";
  return `${mark.sentido}: ${mark.observacion}`;
}

// TEMPORAL (pruebas): borra una marca via RPC eliminar_asistencia, con confirmacion.
async function eliminarMarcaPrueba(id, label) {
  if (!id) return;
  const ok = await confirmGraphical(
    "Eliminar marca de prueba",
    `¿Seguro que quieres ELIMINAR la marca de ${label}? Esta acción no se puede deshacer.`,
    "Sí, eliminar",
    "Cancelar"
  );
  if (!ok) return;

  const { data, error } = await supabaseClient.rpc("eliminar_asistencia", { p_id: id });
  if (error || !data?.ok) {
    const msg = `No se pudo eliminar: ${error?.message || data?.error || "error desconocido"}`;
    setMessage(elements.adminMarksStatus, msg, "error");
    setMessage(elements.journalStatus, msg, "error");
    return;
  }

  // Quita la marca del estado local de AMBAS tablas (Marcas e Ingresos y salidas)
  // y re-renderiza sin recargar todo.
  if (Array.isArray(state.adminMarks)) {
    state.adminMarks = state.adminMarks.filter((m) => m.id !== id);
    renderAdminMarks();
  }
  if (Array.isArray(state.journalMarks)) {
    state.journalMarks = state.journalMarks.filter((m) => m.id !== id);
    renderJournalMarks();
  }
  setMessage(elements.adminMarksStatus, `Marca eliminada (${label}).`, "success");
  setMessage(elements.journalStatus, `Marca eliminada (${label}).`, "success");
}

function calculateJourneyDuration(entrada, salida) {
  if (!entrada || !salida) return salida ? "Sin entrada" : "Pendiente";

  const start = new Date(`${entrada.fecha}T${String(entrada.hora).slice(0, 8)}`);
  const end = new Date(`${salida.fecha}T${String(salida.hora).slice(0, 8)}`);
  const minutes = Math.round((end - start) / 60000);
  if (!Number.isFinite(minutes) || minutes < 0) return "";

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h ${String(rest).padStart(2, "0")}m`;
}

function populateAdminCargoFilter() {
  const current = new Set(getSelectedAdminCargos());
  const cargos = Array.from(new Set(state.adminMarks
    .map((item) => getCargoForDni(item.colaboradores?.dni))
    .filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));

  elements.adminCargoFilter.innerHTML = cargos.map((cargo) => `
    <option value="${escapeHtml(cargo)}" ${current.has(cargo) ? "selected" : ""}>${escapeHtml(cargo)}</option>
  `).join("");
}

function getSelectedAdminCargos() {
  return Array.from(elements.adminCargoFilter.selectedOptions || []).map((option) => option.value);
}

function getCargoForDni(dni) {
  const csvRow = state.csvRows.find((row) => normalizeDni(row.cedula) === normalizeDni(dni));
  return csvRow?.cargo || "";
}

function getDisplayNameForDni(dni, localName = "") {
  const cleanLocalName = String(localName || "").trim();
  if (cleanLocalName && !cleanLocalName.toLowerCase().startsWith("colaborador ")) {
    return cleanLocalName;
  }

  const csvRow = state.csvRows.find((row) => normalizeDni(row.cedula) === normalizeDni(dni));
  return csvRow?.nombre || cleanLocalName || "";
}

function setupJournalDefaults() {
  if (elements.journalDateFromInput.value || elements.journalDateToInput.value) return;
  const now = getTodayParts();
  elements.journalDateFromInput.value = `${now.year}-${now.month}-01`;
  elements.journalDateToInput.value = now.date;
}

async function loadJournalMarks() {
  if (!state.isAdmin) return;
  if (!requireOnline(elements.journalStatus)) return;

  await ensureCsvLoaded();
  const desde = (elements.journalDateFromInput.value || "").trim();
  const hasta = (elements.journalDateToInput.value || "").trim();

  if (desde && hasta && desde > hasta) {
    elements.journalStatus.textContent = "El rango de fechas es invalido (Desde > Hasta).";
    return;
  }

  setBusy(elements.reloadJournalButton, true);
  elements.journalStatus.textContent = "Cargando ingresos y salidas...";

  const PAGE = 1000;
  const TOPE = 20000;
  let acumulado = [];
  let offset = 0;

  try {
    while (offset < TOPE) {
      let query = supabaseClient
        .from("asistencias")
        .select("id,fecha,hora,jornada,sentido,origen,observacion,enviado_buk,buk_status,colaboradores(dni,nombre)")
        .order("fecha", { ascending: false })
        .order("hora", { ascending: false });

      if (desde) query = query.gte("fecha", desde);
      if (hasta) query = query.lte("fecha", hasta);
      query = query.range(offset, offset + PAGE - 1);

      elements.journalStatus.textContent = `Cargando ingresos y salidas... (${acumulado.length})`;
      const { data, error } = await query;
      if (error) {
        elements.journalStatus.textContent = "No se pudieron cargar los ingresos y salidas.";
        return;
      }
      const batch = data || [];
      acumulado = acumulado.concat(batch);
      if (batch.length < PAGE) break;
      offset += PAGE;
    }

    state.journalMarks = acumulado;
    state.journalLoaded = true;
    populateJournalCargoFilter();
    state.journalPage = 1;
    renderJournalMarks();
  } finally {
    setBusy(elements.reloadJournalButton, false);
  }
}

function populateJournalCargoFilter() {
  const current = new Set(getSelectedJournalCargos());
  const cargos = Array.from(new Set(state.journalMarks
    .map((item) => getCargoForDni(item.colaboradores?.dni))
    .filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));

  elements.journalCargoFilter.innerHTML = cargos.map((cargo) => `
    <option value="${escapeHtml(cargo)}" ${current.has(cargo) ? "selected" : ""}>${escapeHtml(cargo)}</option>
  `).join("");
}

function getSelectedJournalCargos() {
  return Array.from(elements.journalCargoFilter.selectedOptions || []).map((option) => option.value);
}

function getFilteredJournalRows() {
  const nameQuery = elements.journalSearchInput.value.trim().toLowerCase();
  const dniQuery = normalizeDni(elements.journalSearchInput.value);
  const selectedCargos = getSelectedJournalCargos();

  return buildAdminJourneys(state.journalMarks).filter((item) => {
    const dni = item.dni || "";
    const name = item.nombre || getDisplayNameForDni(dni);
    const cargo = getCargoForDni(dni);

    if (nameQuery || dniQuery) {
      const matchName = name.toLowerCase().includes(nameQuery);
      const matchDni = dniQuery && normalizeDni(dni).includes(dniQuery);
      if (!matchName && !matchDni) return false;
    }
    if (selectedCargos.length && !selectedCargos.includes(cargo)) return false;
    return true;
  });
}

function renderJournalMarks() {
  const rows = getFilteredJournalRows();
  state.journalFiltered = rows;

  const totalPages = Math.max(1, Math.ceil(rows.length / state.journalPageSize));
  if (state.journalPage > totalPages) state.journalPage = totalPages;
  const start = (state.journalPage - 1) * state.journalPageSize;
  const pageRows = rows.slice(start, start + state.journalPageSize);

  elements.journalStatus.textContent = `${rows.length} jornadas (${state.journalMarks.length} marcas)`;
  elements.journalPageLabel.textContent = `Página ${state.journalPage} de ${totalPages}`;
  elements.journalPrevPageButton.disabled = state.journalPage <= 1;
  elements.journalNextPageButton.disabled = state.journalPage >= totalPages;
  elements.journalBody.innerHTML = pageRows.map((item) => `
    <tr>
      <td>${escapeHtml(item.fecha)}</td>
      <td>${escapeHtml(item.dni || "")}</td>
      <td>${escapeHtml(item.nombre || "")}</td>
      <td>${escapeHtml(getCargoForDni(item.dni) || "")}</td>
      <td>${renderJourneyMark(item.entrada, "entrada")}</td>
      <td>${renderJourneyMark(item.salida, "salida")}</td>
      <td>${escapeHtml(item.tiempo || "")}</td>
      <td>${renderJourneyBuk(item)}</td>
    </tr>
  `).join("");
  renderIcons();
}

function renderJourneyBuk(item) {
  const statuses = [item.entrada, item.salida]
    .filter(Boolean)
    .map((mark) => mark.enviado_buk ? "OK" : String(mark.buk_status || "Pendiente"));
  return escapeHtml(statuses.length ? Array.from(new Set(statuses)).join(" / ") : "Pendiente");
}

function exportJournalToCsv() {
  const rows = state.journalFiltered || [];
  if (!rows.length) {
    setMessage(elements.journalStatus, "No hay ingresos y salidas para exportar con el filtro actual.", "error");
    return;
  }

  const header = ["Fecha", "Cedula", "Nombre", "Cargo", "Entrada", "Salida (fecha)", "Salida (hora)", "Tiempo", "Buk", "Observacion"];
  const escapeCsv = (val) => {
    const s = String(val ?? "");
    if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lineas = [header.join(";")];
  rows.forEach((item) => {
    const dni = item.dni || "";
    const bukStatuses = [item.entrada, item.salida]
      .filter(Boolean)
      .map((mark) => mark.enviado_buk ? "OK" : String(mark.buk_status || "Pendiente"));
    lineas.push([
      item.fecha || "",
      dni,
      item.nombre || getDisplayNameForDni(dni) || "",
      getCargoForDni(dni) || "",
      item.entrada ? String(item.entrada.hora).slice(0, 5) : "",
      item.salida ? (item.salida.fecha || "") : "",
      item.salida ? String(item.salida.hora).slice(0, 5) : "",
      item.tiempo || "",
      bukStatuses.length ? Array.from(new Set(bukStatuses)).join(" / ") : "Pendiente",
      item.observacion || ""
    ].map(escapeCsv).join(";"));
  });

  const desde = (elements.journalDateFromInput.value || "").trim();
  const hasta = (elements.journalDateToInput.value || "").trim();
  const rango = desde || hasta ? `-${desde || "inicio"}_a_${hasta || "hoy"}` : "";
  triggerCsvDownload(lineas.join("\r\n"), `ingresos-salidas${rango}.csv`);
  setMessage(elements.journalStatus, `${rows.length} jornada(s) exportadas a CSV.`, "success");
}

function setupRechazoDefaults() {
  if (elements.rechazoDateFromInput.value || elements.rechazoDateToInput.value) return;
  const now = getTodayParts();
  elements.rechazoDateFromInput.value = `${now.year}-${now.month}-01`;
  elements.rechazoDateToInput.value = now.date;
}

async function loadRechazoMarks() {
  if (!state.isAdmin) return;
  if (!requireOnline(elements.rechazoStatus)) return;

  await ensureCsvLoaded();
  const desde = (elements.rechazoDateFromInput.value || "").trim();
  const hasta = (elements.rechazoDateToInput.value || "").trim();

  if (desde && hasta && desde > hasta) {
    elements.rechazoStatus.textContent = "El rango de fechas es invalido (Desde > Hasta).";
    return;
  }

  setBusy(elements.reloadRechazoButton, true);
  elements.rechazoStatus.textContent = "Cargando marcas rechazadas por Buk...";

  const PAGE = 1000;
  const TOPE = 20000;
  let acumulado = [];
  let offset = 0;

  try {
    while (offset < TOPE) {
      let query = supabaseClient
        .from("asistencias")
        .select("id,fecha,hora,jornada,sentido,origen,observacion,enviado_buk,buk_status,buk_error,colaboradores(dni,nombre)")
        .not("enviado_buk", "is", true)
        .order("fecha", { ascending: false })
        .order("hora", { ascending: false });

      if (desde) query = query.gte("fecha", desde);
      if (hasta) query = query.lte("fecha", hasta);
      query = query.range(offset, offset + PAGE - 1);

      elements.rechazoStatus.textContent = `Cargando marcas rechazadas por Buk... (${acumulado.length})`;
      const { data, error } = await query;
      if (error) {
        elements.rechazoStatus.textContent = "No se pudieron cargar las marcas rechazadas.";
        return;
      }
      const batch = data || [];
      acumulado = acumulado.concat(batch);
      if (batch.length < PAGE) break;
      offset += PAGE;
    }

    state.rechazoMarks = acumulado;
    state.rechazoLoaded = true;
    state.rechazoPage = 1;
    renderRechazoMarks();
  } finally {
    setBusy(elements.reloadRechazoButton, false);
  }
}

function getFilteredRechazoRows() {
  const nameQuery = elements.rechazoSearchInput.value.trim().toLowerCase();
  const dniQuery = normalizeDni(elements.rechazoSearchInput.value);

  return (state.rechazoMarks || []).filter((mark) => {
    const dni = mark.colaboradores?.dni || "";
    const name = (mark.colaboradores?.nombre || getDisplayNameForDni(dni) || "").toLowerCase();
    if (nameQuery || dniQuery) {
      const matchName = name.includes(nameQuery);
      const matchDni = dniQuery && normalizeDni(dni).includes(dniQuery);
      if (!matchName && !matchDni) return false;
    }
    return true;
  });
}

function rechazoEstadoBuk(mark) {
  return mark.buk_error || mark.buk_status || "Sin enviar";
}

function renderRechazoMarks() {
  const rows = getFilteredRechazoRows();
  state.rechazoFiltered = rows;

  const totalPages = Math.max(1, Math.ceil(rows.length / state.rechazoPageSize));
  if (state.rechazoPage > totalPages) state.rechazoPage = totalPages;
  const start = (state.rechazoPage - 1) * state.rechazoPageSize;
  const pageRows = rows.slice(start, start + state.rechazoPageSize);

  elements.rechazoStatus.textContent = rows.length
    ? `${rows.length} marca(s) no confirmada(s) por Buk`
    : "Sin marcas rechazadas por Buk en el rango consultado.";
  elements.rechazoPageLabel.textContent = `Página ${state.rechazoPage} de ${totalPages}`;
  elements.rechazoPrevPageButton.disabled = state.rechazoPage <= 1;
  elements.rechazoNextPageButton.disabled = state.rechazoPage >= totalPages;
  elements.rechazoBody.innerHTML = pageRows.map((mark) => {
    const dni = mark.colaboradores?.dni || "";
    const nombre = mark.colaboradores?.nombre || getDisplayNameForDni(dni) || "Sin nombre";
    return `
      <tr>
        <td>${escapeHtml(mark.fecha)}</td>
        <td>${escapeHtml(String(mark.hora).slice(0, 5))}</td>
        <td>${escapeHtml(dni)}</td>
        <td>${escapeHtml(nombre)}</td>
        <td>${escapeHtml(getCargoForDni(dni) || "")}</td>
        <td><span class="pill ${escapeHtml(mark.sentido)}">${escapeHtml(mark.sentido)}</span></td>
        <td>${escapeHtml(mark.origen || "")}</td>
        <td>${escapeHtml(rechazoEstadoBuk(mark))}</td>
        <td>${escapeHtml(mark.observacion || "")}</td>
        <td><button type="button" class="mini-button rechazo-resend" data-resend-id="${escapeHtml(String(mark.id))}">Reenviar a Buk</button></td>
      </tr>
    `;
  }).join("");
  renderIcons();
}

// Reenvía UNA marca rechazada a Buk reusando la función Edge enviar-asistencia-buk.
// Es "inteligente" para el error "el dni no pertenece al recinto (obra_id) o a la
// empresa": le pregunta a Buk TODAS las obras del colaborador y las prueba una por
// una hasta que alguna acepte la marca. Si el error no es de obra/empresa, no
// insiste con más obras.
async function reenviarMarcaBuk(mark) {
  const dni = mark.colaboradores?.dni || "";
  if (!dni) return { ok: false, error: "La marca no tiene cédula asociada." };

  const { obraId, lookup } = await lookupObraIdDeColaborador(dni);

  // Lista de obras candidatas (sin repetir, respetando el tipo original).
  const candidatas = [];
  const vistas = new Set();
  const agregar = (v) => {
    if (v === null || v === undefined || v === "") return;
    const key = String(v);
    if (vistas.has(key)) return;
    vistas.add(key);
    candidatas.push(v);
  };
  agregar(obraId);
  agregar(lookup?.obra_id_principal);
  (Array.isArray(lookup?.obra_ids) ? lookup.obra_ids : []).forEach(agregar);
  agregar(BUK_OBRA_ID);

  let ultimoError = "No se pudo enviar a Buk.";
  for (const obra of candidatas) {
    const payload = {
      obra_id: obra,
      dni_colaborador: dni,
      jornada: mark.jornada || mark.fecha,
      fecha: mark.fecha,
      hora: String(mark.hora).slice(0, 8),
      sentido: mark.sentido
    };
    const { data: bukData, error: bukError } = await supabaseClient.functions.invoke("enviar-asistencia-buk", { body: payload });
    if (!bukError && bukData?.ok) {
      await marcarEstadoBukEnAsistencia(mark.id, true, bukData);
      return { ok: true, obra };
    }
    ultimoError = mejorErrorBuk(bukData) || bukError?.message || ultimoError;
    // Si Buk dice que YA existe la marca, no es un rechazo real: ya está en Buk.
    if (/ya existe una marca/i.test(ultimoError)) {
      return { ok: false, yaExiste: true, error: ultimoError };
    }
    // Solo tiene sentido probar otra obra si el error es justamente de obra/empresa.
    if (!/recinto|obra|empresa|pertenece/i.test(ultimoError)) break;
  }

  await marcarEstadoBukEnAsistencia(mark.id, false, { error: ultimoError });
  return { ok: false, error: ultimoError };
}

async function onReenviarUnaMarca(id) {
  const mark = (state.rechazoMarks || []).find((m) => m.id === id);
  if (!mark) return;
  setMessage(elements.rechazoStatus, `Reenviando a Buk (${mark.colaboradores?.dni || ""})...`, "");
  const res = await reenviarMarcaBuk(mark);
  if (res.ok) {
    state.rechazoMarks = state.rechazoMarks.filter((m) => m.id !== id);
    renderRechazoMarks();
    setMessage(elements.rechazoStatus, `✅ Marca reenviada y aceptada por Buk (obra ${res.obra}).`, "success");
    return;
  }

  // Caso especial: Buk dice que la marca YA existe. No es un rechazo real, ya está
  // en Buk. Ofrecemos marcarla como confirmada para sacarla de pendientes.
  if (res.yaExiste) {
    const marcar = await confirmGraphical(
      "La marca ya está en Buk",
      `Buk indica: "${res.error}". Es decir, esta marca YA está registrada en Buk (no es un rechazo real). ¿Quieres marcarla como CONFIRMADA para sacarla de la lista de pendientes?`,
      "Sí, marcar como confirmada",
      "Dejarla como está"
    );
    if (marcar) {
      await marcarEstadoBukEnAsistencia(mark.id, true, { status: 200 });
      state.rechazoMarks = state.rechazoMarks.filter((m) => m.id !== id);
      renderRechazoMarks();
      setMessage(elements.rechazoStatus, "✅ Marca confirmada (ya estaba en Buk).", "success");
    } else {
      mark.buk_error = res.error;
      renderRechazoMarks();
    }
    return;
  }

  mark.buk_error = res.error;
  renderRechazoMarks();
  setMessage(elements.rechazoStatus, `❌ Buk volvió a rechazar: ${res.error}`, "error");
}

async function reenviarTodasRechazo() {
  const rows = getFilteredRechazoRows();
  if (!rows.length) {
    setMessage(elements.rechazoStatus, "No hay marcas para reenviar con el filtro actual.", "error");
    return;
  }
  const ok = await confirmGraphical(
    "Reenviar todas a Buk",
    `Se intentará reenviar ${rows.length} marca(s) a Buk. Las que tengan errores permanentes (por ejemplo "el dni no pertenece al recinto o empresa") seguirán fallando hasta que se corrijan en Buk. ¿Continuar?`,
    "Sí, reenviar todas",
    "Cancelar"
  );
  if (!ok) return;

  setBusy(elements.resendAllRechazoButton, true);
  let aceptadas = 0;
  let fallidas = 0;
  for (const mark of [...rows]) {
    setMessage(elements.rechazoStatus, `Reenviando ${aceptadas + fallidas + 1}/${rows.length}...`, "");
    const res = await reenviarMarcaBuk(mark);
    if (res.ok) {
      aceptadas += 1;
      state.rechazoMarks = state.rechazoMarks.filter((m) => m.id !== mark.id);
    } else {
      fallidas += 1;
      mark.buk_error = res.error;
    }
  }
  renderRechazoMarks();
  setBusy(elements.resendAllRechazoButton, false);
  setMessage(
    elements.rechazoStatus,
    `Reenvío terminado: ${aceptadas} aceptada(s), ${fallidas} sigue(n) fallando.`,
    aceptadas ? "success" : "error"
  );
}

function exportRechazoToCsv() {
  const rows = state.rechazoFiltered || [];
  if (!rows.length) {
    setMessage(elements.rechazoStatus, "No hay marcas rechazadas para exportar con el filtro actual.", "error");
    return;
  }

  const header = ["Fecha", "Hora", "Cedula", "Nombre", "Cargo", "Tipo", "Origen", "Estado Buk", "Observacion"];
  const escapeCsv = (val) => {
    const s = String(val ?? "");
    if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lineas = [header.join(";")];
  rows.forEach((mark) => {
    const dni = mark.colaboradores?.dni || "";
    lineas.push([
      mark.fecha || "",
      String(mark.hora).slice(0, 5),
      dni,
      mark.colaboradores?.nombre || getDisplayNameForDni(dni) || "",
      getCargoForDni(dni) || "",
      mark.sentido || "",
      mark.origen || "",
      rechazoEstadoBuk(mark),
      mark.observacion || ""
    ].map(escapeCsv).join(";"));
  });

  const desde = (elements.rechazoDateFromInput.value || "").trim();
  const hasta = (elements.rechazoDateToInput.value || "").trim();
  const rango = desde || hasta ? `-${desde || "inicio"}_a_${hasta || "hoy"}` : "";
  triggerCsvDownload(lineas.join("\r\n"), `rechazos-buk${rango}.csv`);
  setMessage(elements.rechazoStatus, `${rows.length} marca(s) exportadas a CSV.`, "success");
}

function setupInconsistDefaults() {
  if (elements.inconsistDateFromInput.value || elements.inconsistDateToInput.value) return;
  const now = getTodayParts();
  elements.inconsistDateFromInput.value = `${now.year}-${now.month}-01`;
  elements.inconsistDateToInput.value = now.date;
}

async function loadInconsistMarks() {
  if (!state.isAdmin) return;
  if (!requireOnline(elements.inconsistStatus)) return;

  await ensureCsvLoaded();
  const desde = (elements.inconsistDateFromInput.value || "").trim();
  const hasta = (elements.inconsistDateToInput.value || "").trim();

  if (desde && hasta && desde > hasta) {
    elements.inconsistStatus.textContent = "El rango de fechas es invalido (Desde > Hasta).";
    return;
  }

  setBusy(elements.reloadInconsistButton, true);
  elements.inconsistStatus.textContent = "Analizando registros...";
  setMessage(elements.inconsistMessage, "");

  const PAGE = 1000;
  const TOPE = 20000;
  let acumulado = [];
  let offset = 0;

  try {
    while (offset < TOPE) {
      let query = supabaseClient
        .from("asistencias")
        .select("id,fecha,hora,sentido,origen,enviado_buk,buk_status,colaboradores(dni,nombre)")
        .order("fecha", { ascending: false })
        .order("hora", { ascending: false });

      if (desde) query = query.gte("fecha", desde);
      if (hasta) query = query.lte("fecha", hasta);
      query = query.range(offset, offset + PAGE - 1);

      const { data, error } = await query;
      if (error) {
        elements.inconsistStatus.textContent = "No se pudieron cargar los registros.";
        return;
      }
      const batch = data || [];
      acumulado = acumulado.concat(batch);
      if (batch.length < PAGE) break;
      offset += PAGE;
    }

    state.inconsistMarks = acumulado;
    state.inconsistRows = detectarInconsistencias(acumulado);
    state.inconsistLoaded = true;
    renderInconsistencias();
  } finally {
    setBusy(elements.reloadInconsistButton, false);
  }
}

function detectarInconsistencias(marks) {
  const byDni = new Map();
  marks.forEach((mark) => {
    const dni = mark.colaboradores?.dni || "";
    if (!dni) return;
    if (!byDni.has(dni)) byDni.set(dni, []);
    byDni.get(dni).push(mark);
  });

  const rows = [];
  byDni.forEach((items, dni) => {
    const sorted = [...items].sort((a, b) => compareMarkDateTime(a, b));
    let prev = null;

    sorted.forEach((m) => {
      if (m.sentido === "entrada") {
        if (prev && prev.sentido === "entrada") {
          rows.push(buildInconsistRow(dni, prev, "Dos entradas seguidas (falta salida)"));
        }
        prev = m;
      } else if (m.sentido === "salida") {
        if (!prev) {
          rows.push(buildInconsistRow(dni, m, "Salida sin entrada previa"));
        } else if (prev.sentido === "salida") {
          rows.push(buildInconsistRow(dni, m, "Dos salidas seguidas"));
        }
        prev = m;
      }
    });

    if (prev && prev.sentido === "entrada") {
      rows.push(buildInconsistRow(dni, prev, "Entrada sin salida (turno abierto)"));
    }
  });

  return rows.sort((a, b) => `${b.fecha}T${b.hora}`.localeCompare(`${a.fecha}T${a.hora}`));
}

function buildInconsistRow(dni, mark, problema) {
  return {
    id: mark.id,
    dni,
    nombre: mark.colaboradores?.nombre || getDisplayNameForDni(dni) || "Sin nombre",
    cargo: getCargoForDni(dni) || "",
    problema,
    fecha: mark.fecha,
    hora: String(mark.hora).slice(0, 8),
    sentido: mark.sentido,
    origen: mark.origen || "",
    enviado_buk: mark.enviado_buk,
    buk_status: mark.buk_status
  };
}

function getFilteredInconsistRows() {
  const q = elements.inconsistSearchInput.value.trim().toLowerCase();
  const qDni = normalizeDni(elements.inconsistSearchInput.value);
  return (state.inconsistRows || []).filter((r) => {
    if (!q && !qDni) return true;
    const matchName = r.nombre.toLowerCase().includes(q);
    const matchDni = qDni && normalizeDni(r.dni).includes(qDni);
    return matchName || matchDni;
  });
}

function renderInconsistencias() {
  const rows = getFilteredInconsistRows();

  elements.inconsistStatus.textContent = rows.length
    ? `${rows.length} marca(s) con problemas de secuencia entrada/salida`
    : "Sin registros mal formados en el rango consultado. Todo en orden.";

  const hoy = getTodayParts().date;
  elements.inconsistBody.innerHTML = rows.map((r) => {
    const dias = diffDaysBetween(r.fecha, hoy);
    const antig = Number.isFinite(dias) ? `${dias} día${dias === 1 ? "" : "s"}` : "";
    const bukTag = r.enviado_buk ? "Buk OK" : `Buk ${r.buk_status || "sin enviar"}`;
    const claseProblema = /^(Dos salidas|Salida sin)/.test(r.problema) ? "turno-alerta-critica" : "turno-alerta-media";
    return `
      <tr>
        <td>${escapeHtml(r.dni)}</td>
        <td>${escapeHtml(r.nombre)}</td>
        <td>${escapeHtml(r.cargo)}</td>
        <td class="${claseProblema}">${escapeHtml(r.problema)}</td>
        <td>${escapeHtml(r.fecha)}</td>
        <td>${escapeHtml(String(r.hora).slice(0, 5))}</td>
        <td><span class="pill ${escapeHtml(r.sentido)}">${escapeHtml(r.sentido)}</span></td>
        <td>${escapeHtml(antig)}</td>
        <td>${escapeHtml(r.origen)}</td>
        <td>${escapeHtml(bukTag)}</td>
        <td>
          <button type="button" class="mini-button danger" data-del-mark="${escapeHtml(r.id)}"
            data-dni="${escapeHtml(r.dni)}" data-fecha="${escapeHtml(r.fecha)}"
            data-hora="${escapeHtml(String(r.hora).slice(0, 5))}" data-sentido="${escapeHtml(r.sentido)}"
            data-buk="${r.enviado_buk ? "1" : "0"}">
            <i data-lucide="trash-2"></i>
            Eliminar
          </button>
        </td>
      </tr>
    `;
  }).join("");
  renderIcons();
}

async function eliminarMarcaInconsistente(info) {
  if (!state.isAdmin) return;
  if (!requireOnline(elements.inconsistMessage)) return;

  const avisoBuk = info.buk === "1"
    ? " ATENCION: esta marca YA fue enviada a Buk/Ctrlit; eliminarla aqui NO la borra de Buk (nomina). Debes corregirla tambien en Buk."
    : "";

  const ok = await confirmGraphical(
    "Eliminar marca",
    `Vas a ELIMINAR la ${String(info.sentido).toUpperCase()} del ${info.fecha} ${info.hora} (cedula ${info.dni}). Esta accion no se puede deshacer.${avisoBuk}`,
    "Sí, eliminar",
    "Cancelar"
  );
  if (!ok) return;

  setMessage(elements.inconsistMessage, "Eliminando marca...");
  const { data, error } = await supabaseClient
    .from("asistencias")
    .delete()
    .eq("id", info.id)
    .select("id");

  if (error) {
    setMessage(elements.inconsistMessage, `No se pudo eliminar la marca: ${error.message}`, "error");
    return;
  }

  if (!data || !data.length) {
    setMessage(
      elements.inconsistMessage,
      "No se eliminó la marca. Es probable que las políticas de la base (RLS) no permitan borrar en la tabla asistencias. Avísame para prepararte la política que autorice a los administradores a eliminar.",
      "error"
    );
    return;
  }

  setMessage(elements.inconsistMessage, `Marca eliminada (${info.sentido} ${info.fecha} ${info.hora}).`, "success");
  await loadInconsistMarks();
}

function exportInconsistToCsv() {
  const rows = getFilteredInconsistRows();
  if (!rows.length) {
    setMessage(elements.inconsistMessage, "No hay registros mal formados para exportar.", "error");
    return;
  }

  const header = ["Cedula", "Nombre", "Cargo", "Problema", "Fecha", "Hora", "Tipo", "Origen", "Buk"];
  const escapeCsv = (val) => {
    const s = String(val ?? "");
    if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lineas = [header.join(";")];
  rows.forEach((r) => {
    lineas.push([
      r.dni,
      r.nombre,
      r.cargo,
      r.problema,
      r.fecha,
      String(r.hora).slice(0, 5),
      r.sentido,
      r.origen,
      r.enviado_buk ? "Buk OK" : `Buk ${r.buk_status || "sin enviar"}`
    ].map(escapeCsv).join(";"));
  });

  const desde = (elements.inconsistDateFromInput.value || "").trim();
  const hasta = (elements.inconsistDateToInput.value || "").trim();
  const rango = desde || hasta ? `-${desde || "inicio"}_a_${hasta || "hoy"}` : "";
  triggerCsvDownload(lineas.join("\r\n"), `registros-inconsistentes${rango}.csv`);
  setMessage(elements.inconsistMessage, `${rows.length} fila(s) exportadas a CSV.`, "success");
}

// ===== Vigilancia: conductores sin marca propia =====

async function loadSinMarca() {
  if (!requireOnline(elements.sinMarcaStatus)) return;
  const dias = Math.max(1, Math.min(365, parseInt(elements.sinMarcaDaysInput.value, 10) || 90));
  const maxBio = Math.max(0, Math.min(20, parseInt(elements.sinMarcaMaxBioInput.value, 10) || 0));
  elements.sinMarcaStatus.textContent = "Analizando conductores...";
  setMessage(elements.sinMarcaMessage, "");
  elements.sinMarcaBody.innerHTML = "";
  try {
    const { data, error } = await supabaseClient.rpc("conductores_sin_marca_propia", {
      p_dias: dias,
      p_max_bio: maxBio
    });
    if (error) throw error;
    state.sinMarcaRows = Array.isArray(data) ? data : [];
    state.sinMarcaLoaded = true;
    renderSinMarca();
  } catch (error) {
    elements.sinMarcaStatus.textContent = "No se pudieron cargar los conductores.";
    setMessage(elements.sinMarcaMessage, error.message || "Error al consultar.", "error");
  }
}

function getFilteredSinMarcaRows() {
  const q = elements.sinMarcaSearchInput.value.trim().toLowerCase();
  const qDni = normalizeDni(elements.sinMarcaSearchInput.value);
  return (state.sinMarcaRows || []).filter((r) => {
    if (!q) return true;
    return String(r.nombre || "").toLowerCase().includes(q) || String(r.dni || "").includes(qDni);
  });
}

function renderSinMarca() {
  const rows = getFilteredSinMarcaRows();
  elements.sinMarcaStatus.textContent = rows.length
    ? `${rows.length} conductor(es) en vigilancia.`
    : "Sin conductores que cumplan el filtro.";
  elements.sinMarcaBody.innerHTML = rows.map((r) => {
    const alerta = Number(r.biometricas) === 0 ? ' class="row-danger"' : "";
    return `<tr${alerta}>
      <td>${escapeHtml(String(r.dni))}</td>
      <td>${escapeHtml(String(r.nombre || ""))}</td>
      <td>${escapeHtml(String(r.cargo || ""))}</td>
      <td>${r.total}</td>
      <td>${r.reg_admin}</td>
      <td>${r.biometricas}</td>
      <td>${r.pct_admin}%</td>
      <td>${escapeHtml(String(r.ultima_marca || ""))}</td>
    </tr>`;
  }).join("");
}

function exportSinMarcaToCsv() {
  const rows = getFilteredSinMarcaRows();
  if (!rows.length) {
    setMessage(elements.sinMarcaMessage, "No hay conductores para exportar.", "error");
    return;
  }
  const header = ["Cedula", "Nombre", "Cargo", "Total marcas", "Registradas por admin", "Biometricas propias", "% admin", "Ultima marca"];
  const escapeCsv = (val) => {
    const s = String(val ?? "");
    if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lineas = [header.join(";")];
  rows.forEach((r) => {
    lineas.push([r.dni, r.nombre, r.cargo, r.total, r.reg_admin, r.biometricas, `${r.pct_admin}%`, r.ultima_marca].map(escapeCsv).join(";"));
  });
  triggerCsvDownload(lineas.join("\r\n"), "conductores-sin-marca-propia.csv");
  setMessage(elements.sinMarcaMessage, `${rows.length} fila(s) exportadas a CSV.`, "success");
}

// ===== Validacion de turnos (jornadas emparejadas entrada->salida desde el 8-jul) =====

function setupValidacionDefaults() {
  if (elements.validacionDateFromInput.value || elements.validacionDateToInput.value) return;
  elements.validacionDateFromInput.value = FECHA_CORTE_VALIDACIONES;
  elements.validacionDateToInput.value = getTodayParts().date;
}

function markTsValidacion(m) {
  if (!m || !m.fecha) return 0;
  return new Date(`${m.fecha}T${String(m.hora || "00:00:00").slice(0, 8)}`).getTime();
}

async function loadValidacionTurnos() {
  if (!state.isAdmin) return;
  if (!requireOnline(elements.validacionStatus)) return;
  await ensureCsvLoaded();

  const desde = (elements.validacionDateFromInput.value || "").trim();
  const hasta = (elements.validacionDateToInput.value || "").trim();
  if (desde && hasta && desde > hasta) {
    elements.validacionStatus.textContent = "El rango de fechas es inválido (Desde > Hasta).";
    return;
  }

  setBusy(elements.reloadValidacionButton, true);
  elements.validacionStatus.textContent = "Analizando jornadas...";
  setMessage(elements.validacionMessage, "");

  // Cargamos un dia antes del "desde" para emparejar turnos nocturnos que cruzan la medianoche.
  const desdeBuffer = desde ? addDays(desde, -1) : desde;
  const maxHoras = Math.max(1, parseInt(elements.validacionMaxHorasInput.value, 10) || 14);

  const PAGE = 1000;
  const TOPE = 40000;
  let acumulado = [];
  let offset = 0;
  try {
    while (offset < TOPE) {
      let query = supabaseClient
        .from("asistencias")
        .select("id,fecha,hora,jornada,sentido,origen,enviado_buk,buk_status,colaboradores(dni,nombre)")
        .order("fecha", { ascending: true })
        .order("hora", { ascending: true });
      if (desdeBuffer) query = query.gte("fecha", desdeBuffer);
      if (hasta) query = query.lte("fecha", hasta);
      query = query.range(offset, offset + PAGE - 1);
      const { data, error } = await query;
      if (error) {
        elements.validacionStatus.textContent = "No se pudieron cargar los registros.";
        return;
      }
      const batch = data || [];
      acumulado = acumulado.concat(batch);
      if (batch.length < PAGE) break;
      offset += PAGE;
    }

    let rows = construirJornadasValidacion(acumulado, maxHoras);
    // Solo mostramos jornadas ancladas en el rango pedido (el buffer es solo para emparejar).
    if (desde) rows = rows.filter((r) => (r.entradaFecha && r.entradaFecha >= desde) || (r.salidaFecha && r.salidaFecha >= desde));
    rows.sort((a, b) => b.ordenTs - a.ordenTs);
    state.validacionRows = rows;
    state.validacionLoaded = true;
    renderValidacion();
  } finally {
    setBusy(elements.reloadValidacionButton, false);
  }
}

function construirJornadasValidacion(marks, maxHoras) {
  const byDni = new Map();
  marks.forEach((m) => {
    const dni = normalizeDni(m.colaboradores?.dni || "");
    if (!dni) return;
    if (!byDni.has(dni)) byDni.set(dni, []);
    byDni.get(dni).push(m);
  });

  const rows = [];
  byDni.forEach((items, dni) => {
    const sorted = [...items].sort((a, b) => markTsValidacion(a) - markTsValidacion(b));
    let abierta = null;
    sorted.forEach((m) => {
      if (m.sentido === "entrada") {
        if (abierta) rows.push(makeJornadaValidacion(dni, abierta, null, "abierta_doble", maxHoras));
        abierta = m;
      } else if (m.sentido === "salida") {
        if (abierta) { rows.push(makeJornadaValidacion(dni, abierta, m, "cerrada", maxHoras)); abierta = null; }
        else rows.push(makeJornadaValidacion(dni, null, m, "salida_sin_entrada", maxHoras));
      }
    });
    if (abierta) rows.push(makeJornadaValidacion(dni, abierta, null, "abierta", maxHoras));
  });
  return rows;
}

function makeJornadaValidacion(dni, entrada, salida, tipo, maxHoras) {
  const nombre = entrada?.colaboradores?.nombre || salida?.colaboradores?.nombre || getDisplayNameForDni(dni) || "Sin nombre";
  const cargo = getCargoForDni(dni) || "";
  const jornada = entrada?.jornada || salida?.jornada || entrada?.fecha || salida?.fecha || "";
  let horas = null;
  if (entrada && salida) {
    const diff = markTsValidacion(salida) - markTsValidacion(entrada);
    horas = diff > 0 ? diff / 3600000 : 0;
  }
  const bukProblema = [entrada, salida].some((m) => m && (m.enviado_buk === false || m.buk_status === 400));

  let etiqueta, severidad, cat;
  if (tipo === "salida_sin_entrada") { etiqueta = "Salida sin entrada"; severidad = "danger"; cat = "salida_sin"; }
  else if (tipo === "abierta_doble") { etiqueta = "Doble entrada (falta salida)"; severidad = "danger"; cat = "doble"; }
  else if (tipo === "abierta") { etiqueta = "Turno abierto"; severidad = "warn"; cat = "abierto"; }
  else if (horas != null && horas > maxHoras) { etiqueta = `Exceso de horas (${horas.toFixed(1)} h)`; severidad = "danger"; cat = "exceso"; }
  else if (bukProblema) { etiqueta = "Rechazo/no envío Buk"; severidad = "warn"; cat = "buk"; }
  else { etiqueta = "Correcto"; severidad = "ok"; cat = "correcto"; }

  return {
    dni, nombre, cargo, jornada,
    entradaFecha: entrada?.fecha || "", entradaHora: entrada ? String(entrada.hora).slice(0, 5) : "",
    salidaFecha: salida?.fecha || "", salidaHora: salida ? String(salida.hora).slice(0, 5) : "",
    horas, bukProblema, etiqueta, severidad, cat,
    ordenTs: Math.max(markTsValidacion(entrada), markTsValidacion(salida))
  };
}

function getFilteredValidacionRows() {
  const q = elements.validacionSearchInput.value.trim().toLowerCase();
  const qDni = normalizeDni(elements.validacionSearchInput.value);
  const tipo = elements.validacionFiltroTipo.value;
  return (state.validacionRows || []).filter((r) => {
    if (tipo === "problemas" && r.severidad === "ok") return false;
    if (tipo === "secuencia" && r.cat !== "doble" && r.cat !== "salida_sin") return false;
    if (tipo !== "todas" && tipo !== "problemas" && tipo !== "secuencia" && r.cat !== tipo) return false;
    if (!q && !qDni) return true;
    const matchName = r.nombre.toLowerCase().includes(q);
    const matchDni = qDni && normalizeDni(r.dni).includes(qDni);
    return matchName || matchDni;
  });
}

function renderValidacion() {
  const all = state.validacionRows || [];
  const rows = getFilteredValidacionRows();

  const cont = { ok: 0, abierto: 0, secuencia: 0, exceso: 0, buk: 0 };
  all.forEach((r) => {
    if (r.severidad === "ok") cont.ok++;
    else if (r.etiqueta === "Turno abierto") cont.abierto++;
    else if (/Exceso/.test(r.etiqueta)) cont.exceso++;
    else if (/Buk/.test(r.etiqueta)) cont.buk++;
    else cont.secuencia++;
  });

  elements.validacionResumen.innerHTML = `
    <button type="button" class="chip todas" data-filtro="todas">Todas: ${all.length}</button>
    <button type="button" class="chip ok" data-filtro="correcto">Correctos: ${cont.ok}</button>
    <button type="button" class="chip warn" data-filtro="abierto">Turnos abiertos: ${cont.abierto}</button>
    <button type="button" class="chip danger" data-filtro="secuencia">Secuencia: ${cont.secuencia}</button>
    <button type="button" class="chip danger" data-filtro="exceso">Exceso horas: ${cont.exceso}</button>
    <button type="button" class="chip warn" data-filtro="buk">Rechazo Buk: ${cont.buk}</button>
  `;

  elements.validacionStatus.textContent = `${all.length} jornada(s) analizadas (${rows.length} en pantalla).`;

  elements.validacionBody.innerHTML = rows.map((r) => {
    const horasTxt = r.horas != null ? `${r.horas.toFixed(1)} h` : "--";
    const bukTxt = r.bukProblema ? "Problema" : "OK";
    return `
      <tr class="${r.severidad === "danger" ? "row-danger" : ""}">
        <td>${escapeHtml(r.dni)}</td>
        <td>${escapeHtml(r.nombre)}</td>
        <td>${escapeHtml(r.cargo)}</td>
        <td>${escapeHtml(r.jornada)}</td>
        <td>${r.entradaFecha ? escapeHtml(`${r.entradaFecha} ${r.entradaHora}`) : "--"}</td>
        <td>${r.salidaFecha ? escapeHtml(`${r.salidaFecha} ${r.salidaHora}`) : "--"}</td>
        <td>${escapeHtml(horasTxt)}</td>
        <td>${escapeHtml(bukTxt)}</td>
        <td><span class="valid-pill ${r.severidad}">${escapeHtml(r.etiqueta)}</span></td>
      </tr>`;
  }).join("");
}

function exportValidacionToCsv() {
  const rows = getFilteredValidacionRows();
  if (!rows.length) {
    setMessage(elements.validacionMessage, "No hay jornadas para exportar.", "error");
    return;
  }
  const header = ["Cedula", "Nombre", "Cargo", "Jornada", "Entrada", "Salida", "Horas", "Buk", "Validacion"];
  const escapeCsv = (val) => {
    const s = String(val ?? "");
    if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lineas = [header.join(";")];
  rows.forEach((r) => {
    lineas.push([
      r.dni, r.nombre, r.cargo, r.jornada,
      r.entradaFecha ? `${r.entradaFecha} ${r.entradaHora}` : "",
      r.salidaFecha ? `${r.salidaFecha} ${r.salidaHora}` : "",
      r.horas != null ? r.horas.toFixed(1) : "",
      r.bukProblema ? "Problema" : "OK",
      r.etiqueta
    ].map(escapeCsv).join(";"));
  });
  const desde = (elements.validacionDateFromInput.value || "").trim();
  const hasta = (elements.validacionDateToInput.value || "").trim();
  triggerCsvDownload(lineas.join("\r\n"), `validacion-turnos-${desde || "inicio"}_a_${hasta || "hoy"}.csv`);
  setMessage(elements.validacionMessage, `${rows.length} jornada(s) exportadas a CSV.`, "success");
}

function renderSonarDriverOptions() {
  const query = elements.sonarDriverSearchInput.value.trim().toLowerCase();
  const todos = state.sonarDrivers || [];
  const drivers = todos.filter((driver) => {
    if (!query) return true;
    return [driver.cedula, driver.nombre, driver.dr_id]
      .some((value) => String(value || "").toLowerCase().includes(query));
  });

  elements.sonarDriverSelect.innerHTML = `
    <option value="">Selecciona conductor Sonar</option>
    ${todos.map((driver) => `
      <option
        value="${escapeHtml(driver.dr_id)}"
        data-cedula="${escapeHtml(driver.cedula || "")}"
        data-nombre="${escapeHtml(driver.nombre || "")}"
      >${escapeHtml(driver.cedula || "Sin cédula")} - ${escapeHtml(driver.nombre || "Sin nombre")}</option>
    `).join("")}
  `;
  if (state.selectedSonarDriverId) {
    elements.sonarDriverSelect.value = state.selectedSonarDriverId;
  }

  const visibles = drivers.slice(0, 50);
  if (!drivers.length) {
    elements.sonarDriverList.innerHTML = `<li class="sonar-driver-list-empty">${todos.length ? "No hay conductores para mostrar con ese filtro." : "Carga la base con Consumir conductores."}</li>`;
  } else {
    elements.sonarDriverList.innerHTML = visibles.map((driver) => {
      const seleccionado = state.selectedSonarDriverId === driver.dr_id;
      return `
        <li class="sonar-driver-item ${seleccionado ? "selected" : ""}"
            data-driver-id="${escapeHtml(driver.dr_id)}"
            data-cedula="${escapeHtml(driver.cedula || "")}"
            data-nombre="${escapeHtml(driver.nombre || "")}"
            role="option"
            aria-selected="${seleccionado}">
          <div>
            <div>${escapeHtml(driver.nombre || "Sin nombre")}</div>
            <div class="driver-meta">CC ${escapeHtml(driver.cedula || "Sin cedula")} &middot; dr_id ${escapeHtml(driver.dr_id)}</div>
          </div>
          ${seleccionado ? '<i data-lucide="check"></i>' : ""}
        </li>
      `;
    }).join("");
    if (drivers.length > visibles.length) {
      elements.sonarDriverList.innerHTML += `<li class="sonar-driver-list-empty">Mostrando ${visibles.length} de ${drivers.length}. Refina la busqueda para ver mas.</li>`;
    }
    renderIcons();
  }

  elements.sonarAdminStatus.className = "result-box";
  elements.sonarAdminStatus.innerHTML = drivers.length
    ? `<strong>${drivers.length}</strong> conductor(es) coinciden con "${escapeHtml(query) || "todos"}".`
    : (todos.length ? "No hay conductores para mostrar con ese filtro." : "Aun no hay conductores cargados.");

  renderSonarDriverSelectedLabel();
}

function renderSonarDriverSelectedLabel() {
  if (!elements.sonarDriverSelected) return;
  const driver = (state.sonarDrivers || []).find((d) => d.dr_id === state.selectedSonarDriverId);
  if (!driver) {
    elements.sonarDriverSelected.innerHTML = '<span class="muted">Ningun conductor seleccionado.</span>';
    return;
  }
  elements.sonarDriverSelected.innerHTML = `
    Conductor: <strong>${escapeHtml(driver.nombre || "Sin nombre")}</strong> &middot;
    CC ${escapeHtml(driver.cedula || "Sin cedula")} &middot;
    dr_id <strong>${escapeHtml(driver.dr_id)}</strong>
  `;
}

function selectSonarDriver(driverId) {
  state.selectedSonarDriverId = driverId || null;
  elements.sonarDriverSelect.value = driverId || "";
  renderSonarDriverOptions();
  updateSonarSelectionBox();
}

function updateSonarSelectionBox() {
  const driverOption = elements.sonarDriverSelect.selectedOptions?.[0];
  const vehicleOption = elements.sonarVehicleSelect.selectedOptions?.[0];
  const driverId = driverOption?.value || "";
  const driverName = driverOption?.dataset.nombre || "";
  const driverDni = driverOption?.dataset.cedula || "";
  const mId = vehicleOption?.value || "";
  const interno = vehicleOption?.dataset.interno || "";
  const placa = vehicleOption?.dataset.placa || "";

  if (!driverId && !mId) {
    elements.sonarSelectionBox.className = "result-box muted";
    elements.sonarSelectionBox.textContent = "Selecciona conductor y vehículo para ver el dr_id y el mId que se enviarán a Sonar.";
    return;
  }

  elements.sonarSelectionBox.className = "result-box";
  elements.sonarSelectionBox.innerHTML = `
    <strong>Datos que se enviarán a Sonar</strong>
    <div>Conductor: ${escapeHtml(driverDni || "Sin cédula")} - ${escapeHtml(driverName || "Sin nombre")}</div>
    <div>dr_id del conductor: ${escapeHtml(driverId || "Pendiente")}</div>
    <div>Vehículo: ${escapeHtml(interno || "Pendiente")}${placa ? ` - ${escapeHtml(placa)}` : ""}</div>
    <div>mId del vehículo: ${escapeHtml(mId || "Pendiente")}</div>
  `;
}

function parseSonarAssignmentResponse(rawXml = "") {
  const xml = String(rawXml || "").trim();
  if (!xml) {
    return {
      status: "",
      description: "",
      errorCode: "",
      ok: false
    };
  }

  try {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const resultNode = doc.querySelector("SET_DriverAssignResult");
    const status = resultNode?.querySelector("status")?.textContent?.trim() || "";
    const description = resultNode?.querySelector("description")?.textContent?.trim() || "";
    const errorCode = resultNode?.querySelector("error_code")?.textContent?.trim() || "";
    const statusUpper = status.toUpperCase();
    const descriptionLower = description.toLowerCase();
    const ok = statusUpper === "OK" && (
      !errorCode
      || errorCode === "0"
      || errorCode === "255"
      || descriptionLower.includes("se ha asignado el vehiculo")
    );

    return { status, description, errorCode, ok };
  } catch (_error) {
    return {
      status: "",
      description: "",
      errorCode: "",
      ok: false
    };
  }
}

async function invokeSonarAssignmentWebhook({ mid, driverId }) {
  const url = new URL(SONAR_ASSIGN_WEBHOOK_URL);
  url.searchParams.set("mid", mid);
  url.searchParams.set("driverId", driverId);
  url.searchParams.set("_ts", String(Date.now()));

  await new Promise((resolve, reject) => {
    const img = new Image();
    let settled = false;

    const cleanup = () => {
      img.onload = null;
      img.onerror = null;
    };

    img.onload = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    };

    img.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    };

    img.src = url.toString();

    window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    }, 4000);
  });

  return {
    ok: true,
    httpStatus: 200,
    payload: {
      sent: true,
      mid,
      driverId,
      url: url.toString()
    },
    parsed: null,
    error: null
  };
}

async function ensureSonarDriversLoaded() {
  if (state.sonarDrivers.length) return state.sonarDrivers;

  const { data, error } = await supabaseClient.functions.invoke("asignar-conductor-sonar-v2", {
    body: { accion: "listar_conductores" }
  });

  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || "No se pudieron consultar conductores Sonar.");
  state.sonarDrivers = Array.isArray(data.conductores) ? data.conductores : [];
  return state.sonarDrivers;
}

async function findSonarDriverByDni(dni) {
  const drivers = await ensureSonarDriversLoaded();
  return drivers.find((driver) => normalizeDni(driver.cedula) === normalizeDni(dni)) || null;
}

async function loadSonarDrivers() {
  if (!state.isAdmin) return;
  if (!requireOnline(elements.sonarAdminMessage)) return;

  setBusy(elements.loadSonarDriversButton, true);
  setMessage(elements.sonarAdminMessage, "Consultando conductores en Sonar...");
  elements.sonarAdminStatus.className = "result-box muted";
  elements.sonarAdminStatus.textContent = "Consumiento conductores desde Sonar...";

  try {
    state.sonarDrivers = await ensureSonarDriversLoaded();
    renderSonarDriverOptions();
    updateSonarSelectionBox();
    setMessage(elements.sonarAdminMessage, `Conductores cargados desde Sonar: ${state.sonarDrivers.length}.`, "success");
  } catch (error) {
    state.sonarDrivers = [];
    elements.sonarDriverSelect.innerHTML = `<option value="">No se pudieron cargar conductores</option>`;
    elements.sonarAdminStatus.className = "result-box";
    elements.sonarAdminStatus.textContent = "No se pudieron consumir los conductores de Sonar.";
    setMessage(elements.sonarAdminMessage, error.message || "Error consultando conductores en Sonar.", "error");
  } finally {
    setBusy(elements.loadSonarDriversButton, false);
  }
}

async function assignSonarDriverManually(event) {
  event.preventDefault();
  if (!state.isAdmin) return;
  if (!requireOnline(elements.sonarAdminMessage)) return;

  const driverOption = elements.sonarDriverSelect.selectedOptions?.[0];
  const vehicleOption = elements.sonarVehicleSelect.selectedOptions?.[0];
  const driverId = driverOption?.value || "";
  const mId = vehicleOption?.value || "";
  const interno = vehicleOption?.dataset.interno || "";
  const placa = vehicleOption?.dataset.placa || "";
  const dni = driverOption?.dataset.cedula || "";

  if (!driverId) {
    setMessage(elements.sonarAdminMessage, "Selecciona un conductor de Sonar.", "error");
    return;
  }

  if (!mId || !interno) {
    setMessage(elements.sonarAdminMessage, "Selecciona un vehículo para asignar.", "error");
    return;
  }

  setBusy(elements.assignSonarDriverButton, true);
  setMessage(elements.sonarAdminMessage, "Asignando conductor al vehículo...");
  updateSonarSelectionBox();

  try {
    const result = await invokeSonarAssignmentWebhook({
      mid: mId,
      driverId
    });

    if (!result.ok) {
      const detail = [
        result.error || "Sonar rechazó la asignación.",
        `dr_id ${driverId}`,
        `mId ${mId}`
      ].join(" | ");
      throw new Error(detail);
    }

    elements.sonarAdminStatus.className = "result-box";
    elements.sonarAdminStatus.innerHTML = `
      <strong>Solicitud enviada</strong>
      <div>Conductor: ${escapeHtml(driverOption.dataset.nombre || driverId)}</div>
      <div>Vehículo: ${escapeHtml(interno)}${placa ? ` - ${escapeHtml(placa)}` : ""}</div>
      <div>mId enviado: ${escapeHtml(mId)}</div>
      <div>driverId enviado: ${escapeHtml(driverId)}</div>
      <div>Destino: Google Apps Script</div>
    `;
    setMessage(elements.sonarAdminMessage, "Solicitud enviada a Google Apps Script para asignar conductor.", "success");
  } catch (error) {
    setMessage(elements.sonarAdminMessage, error.message || "No se pudo asignar el conductor en Sonar.", "error");
  } finally {
    setBusy(elements.assignSonarDriverButton, false);
  }
}

// ===== Salida manual segura: codigo dinamico + ubicacion + selfie del lider =====

function resetManualSecureBlock() {
  state.manualAuthId = null;
  state.manualLocation = null;
  state.manualSelfieBlob = null;
  if (elements.manualCodeShown) {
    elements.manualCodeShown.classList.add("hidden");
    elements.manualCodeShown.textContent = "";
  }
  if (elements.manualCodeInput) {
    elements.manualCodeInput.value = "";
    elements.manualCodeInput.disabled = true;
  }
  if (elements.manualLocationStatus) {
    elements.manualLocationStatus.textContent = "Ubicación obligatoria: se captura automáticamente.";
    elements.manualLocationStatus.classList.remove("ok");
  }
  elements.manualLocationButton?.classList.add("hidden");
  elements.manualCameraButton?.classList.remove("hidden");
  stopManualCamera();
  if (elements.manualPhotoPreview) elements.manualPhotoPreview.classList.add("hidden");
}

async function manualRequestCode() {
  if (!requireOnline(elements.manualMessage)) return;
  const dni = normalizeDni(elements.manualDniInput.value);
  const categoria = elements.manualReasonCategory.value;
  if (!dni || !categoria) {
    setMessage(elements.manualMessage, "Primero escribe la cédula y elige el motivo, luego solicita el código.", "error");
    return;
  }
  const detalle = elements.manualReasonInput.value.trim();
  const motivo = categoria === "Otro" ? detalle : (detalle ? `${categoria}: ${detalle}` : categoria);

  setBusy(elements.manualCodeButton, true);
  try {
    const { data, error } = await supabaseClient.rpc("generar_codigo_salida_manual", {
      p_colaborador_dni: dni,
      p_motivo: motivo
    });
    if (error) throw error;
    state.manualAuthId = data.id;
    elements.manualCodeShown.textContent = `Código: ${data.codigo} (válido 5 minutos)`;
    elements.manualCodeShown.classList.remove("hidden");
    elements.manualCodeInput.disabled = false;
    elements.manualCodeInput.value = "";
    elements.manualCodeInput.focus();
    setMessage(elements.manualMessage, "Código generado. Escríbelo abajo para confirmar.", "success");
    // Si aun no hay ubicacion, intentala automaticamente en paralelo.
    if (!state.manualLocation) manualAutoLocation();
  } catch (error) {
    setMessage(elements.manualMessage, error.message || "No se pudo generar el código.", "error");
  } finally {
    setBusy(elements.manualCodeButton, false);
  }
}

// Intenta capturar la ubicacion automaticamente (sin que el usuario toque el boton).
// Si el permiso esta bloqueado, muestra el boton/ayuda para habilitarlo.
async function manualAutoLocation() {
  if (!navigator.geolocation) return;
  if (state.manualLocation) return;
  const permiso = await estadoPermisoUbicacion();
  if (permiso === "denied") {
    elements.manualLocationButton?.classList.remove("hidden");
    elements.manualLocationStatus.textContent = "Ubicación BLOQUEADA en el navegador. Habilítala para poder registrar.";
    elements.manualLocationStatus.classList.remove("ok");
    return;
  }
  // 'granted' o 'prompt': capturar directo.
  await manualCaptureLocation();
}

async function manualCaptureLocation() {
  if (!requireOnline(elements.manualMessage)) return;
  setBusy(elements.manualLocationButton, true);
  elements.manualLocationStatus.textContent = "Obteniendo ubicación automáticamente...";
  elements.manualLocationStatus.classList.remove("ok");
  try {
    const location = await getLocation();
    if (location.error || !location.latitud || !location.longitud) {
      state.manualLocation = null;
      elements.manualLocationButton?.classList.remove("hidden");
      elements.manualLocationStatus.textContent = `${location.message || "No se pudo obtener la ubicación."} Toca "Activar ubicación" para reintentar.`;
      if (location.error === "denied") mostrarInstruccionesUbicacionDenegada?.();
      return;
    }
    state.manualLocation = location;
    elements.manualLocationButton?.classList.add("hidden");
    elements.manualLocationStatus.textContent =
      `Ubicación lista: Lat ${Number(location.latitud).toFixed(6)}, Lon ${Number(location.longitud).toFixed(6)} (±${Math.round(location.precision || 0)} m).`;
    elements.manualLocationStatus.classList.add("ok");
    maybeAutoOpenManualCamera();
  } finally {
    setBusy(elements.manualLocationButton, false);
  }
}

// Abre la camara sola cuando ya se completaron los pasos previos y falta la foto.
function maybeAutoOpenManualCamera() {
  const dni = normalizeDni(elements.manualDniInput.value);
  const categoria = elements.manualReasonCategory.value;
  const codigo = elements.manualCodeInput.value.trim();
  const listo = dni && categoria && state.manualAuthId && codigo.length === 6 && state.manualLocation;
  if (!listo) return;
  if (state.manualSelfieBlob) return;   // ya hay foto
  if (state.manualCameraStream) return; // camara ya abierta
  manualStartCamera();
}

async function manualStartCamera() {
  if (!requireOnline(elements.manualMessage)) return;
  if (state.manualCameraStream) {
    elements.manualCameraBox.classList.remove("hidden");
    return;
  }
  try {
    state.manualCameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    elements.manualCameraVideo.srcObject = state.manualCameraStream;
    elements.manualCameraBox.classList.remove("hidden");
    elements.manualPhotoPreview.classList.add("hidden");
    elements.manualCameraButton?.classList.add("hidden");
    setMessage(elements.manualMessage, "Cámara abierta: toma la foto del líder.", "");
  } catch (_error) {
    // Si el navegador bloquea la apertura automatica, mostramos el boton para hacerlo manual.
    elements.manualCameraButton?.classList.remove("hidden");
    setMessage(elements.manualMessage, "Toca \"Abrir cámara\" para tomar la foto del líder.", "error");
  }
}

function stopManualCamera() {
  if (state.manualCameraStream) {
    state.manualCameraStream.getTracks().forEach((track) => track.stop());
    state.manualCameraStream = null;
  }
  if (elements.manualCameraVideo) elements.manualCameraVideo.srcObject = null;
  if (elements.manualCameraBox) elements.manualCameraBox.classList.add("hidden");
}

async function manualCapturePhoto() {
  const video = elements.manualCameraVideo;
  if (!video.videoWidth || !video.videoHeight) {
    setMessage(elements.manualMessage, "La cámara aún no está lista.", "error");
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  const compressed = await compressImage(new File([blob], "selfie.jpg", { type: "image/jpeg" }), 720, 0.72);
  state.manualSelfieBlob = compressed;
  elements.manualPhotoImg.src = URL.createObjectURL(compressed);
  elements.manualPhotoPreview.classList.remove("hidden");
  stopManualCamera();
  setMessage(elements.manualMessage, "Foto del líder lista.", "success");
}

async function registerManualExit(event) {
  event.preventDefault();
  if (!state.isAdmin) return;
  if (!requireOnline(elements.manualMessage)) return;

  const dni = normalizeDni(elements.manualDniInput.value);
  const fecha = elements.manualDateInput.value;
  const hora = elements.manualTimeInput.value;
  const categoria = elements.manualReasonCategory.value;
  const detalle = elements.manualReasonInput.value.trim();

  if (!dni || !fecha || !hora || !categoria) {
    setMessage(elements.manualMessage, "Completa cedula, fecha, hora y motivo.", "error");
    return;
  }

  if (categoria === "Otro" && !detalle) {
    setMessage(elements.manualMessage, "Cuando el motivo es 'Otro' debes escribir el detalle.", "error");
    return;
  }

  // Blindaje antifraude: codigo dinamico + ubicacion + selfie del lider son obligatorios.
  const codigo = elements.manualCodeInput.value.trim();
  if (!state.manualAuthId || !codigo) {
    setMessage(elements.manualMessage, "Solicita el código de autorización (paso 1) y escríbelo antes de registrar.", "error");
    return;
  }
  if (!state.manualLocation) {
    setMessage(elements.manualMessage, "Activa la ubicación (paso 2). Es obligatoria para registrar.", "error");
    return;
  }
  if (!state.manualSelfieBlob) {
    setMessage(elements.manualMessage, "Toma la foto del líder (paso 3). Es obligatoria para registrar.", "error");
    return;
  }

  const motivo = categoria === "Otro"
    ? detalle
    : (detalle ? `${categoria}: ${detalle}` : categoria);

  const csvCollaborator = await findActiveCsvCollaborator(dni);
  if (!csvCollaborator) {
    setMessage(elements.manualMessage, "La cedula no esta activa en la base de colaboradores.", "error");
    return;
  }

  setBusy(elements.manualExitButton, true);
  setMessage(elements.manualMessage, "Validando ultima marca...");

  try {
    // 1) Validar el codigo dinamico ANTES de tocar nada (sin consumirlo todavia).
    setMessage(elements.manualMessage, "Validando código de autorización...");
    const { error: codeError } = await supabaseClient.rpc("validar_codigo_salida_manual", {
      p_id: state.manualAuthId,
      p_codigo: codigo
    });
    if (codeError) {
      throw new Error(codeError.message || "Código de autorización inválido o vencido.");
    }

    const colaborador = await ensureExistingCollaborator(csvCollaborator);
    if (!colaborador) return;

    const { data: lastRows, error: lastError } = await supabaseClient
      .from("asistencias")
      .select("sentido,fecha,hora")
      .eq("colaborador_id", colaborador.id)
      .order("fecha", { ascending: false })
      .order("hora", { ascending: false })
      .limit(1);

    if (lastError) throw lastError;

    const last = lastRows?.[0];
    if (!last || last.sentido !== "entrada") {
      const detalle = last
        ? `La ultima marca fue una ${last.sentido} el ${last.fecha} ${String(last.hora).slice(0, 5)}.`
        : "El colaborador no tiene marcas registradas.";
      setMessage(elements.manualMessage, "No se puede registrar salida manual: el colaborador no tiene entrada abierta.", "error");
      showAlertModal(
        "Sin entrada abierta",
        `No se puede registrar la salida manual: ${detalle} Verifica con el colaborador antes de continuar.`
      );
      return;
    }

    const jornadaBuk = computeJornadaForMark("salida", fecha, last.fecha);

    if (jornadaBuk !== fecha) {
      showAlertModal(
        "Cierre de turno nocturno",
        `Esta salida cerrara la jornada ${jornadaBuk} (entrada del ${last.fecha} a las ${String(last.hora).slice(0, 5)}).`
      );
    }

    // 2) Subir la selfie del lider (evidencia obligatoria). Si falla, abortamos
    //    (el codigo sigue sin consumirse) para no dejar salidas sin evidencia.
    setMessage(elements.manualMessage, "Subiendo foto del líder...");
    const selfiePath = `salidas-manuales/${fecha}/${dni}-${Date.now()}.webp`;
    const { error: selfieError } = await supabaseClient.storage
      .from(config.FOTO_BUCKET)
      .upload(selfiePath, state.manualSelfieBlob, { contentType: "image/webp", upsert: false });
    if (selfieError) {
      throw new Error(`No se pudo subir la foto del líder: ${selfieError.message || "error de almacenamiento"}. Intenta de nuevo.`);
    }

    const ubic = state.manualLocation;
    const observacion = `Salida manual. Motivo: ${motivo} | Autorizada por ${state.user.email || state.user.id} con código`;
    const { data: insertedAttendance, error: insertError } = await supabaseClient
      .from("asistencias")
      .insert({
        colaborador_id: colaborador.id,
        obra_id: colaborador.obra_id,
        fecha,
        hora,
        jornada: jornadaBuk,
        sentido: "salida",
        origen: "manual",
        registrado_por: state.user.id,
        foto_path: selfiePath,
        foto_eliminar_en: addDays(getTodayParts().date, 25),
        latitud: ubic?.latitud ?? null,
        longitud: ubic?.longitud ?? null,
        ubicacion_precision_m: ubic?.precision ?? null,
        observacion
      })
      .select("id")
      .single();

    if (insertError) throw insertError;

    const { obraId: obraIdReal } = await lookupObraIdDeColaborador(colaborador.dni);
    const obraIdAUsar = obraIdReal || BUK_OBRA_ID;

    const { data: bukData, error: bukError } = await invocarBukConReintento({
      asistencia_id: insertedAttendance.id,
      obra_id: obraIdAUsar,
      dni_colaborador: colaborador.dni,
      jornada: jornadaBuk,
      fecha,
      hora,
      sentido: "salida"
    });

    const bukOk = !bukError && !!bukData?.ok;

    await marcarEstadoBukEnAsistencia(insertedAttendance.id, bukOk, bukData, bukError);

    // 3) Consumir el codigo (un solo uso) y dejar la auditoria completa:
    //    quien, ubicacion, foto y referencia a la marca creada.
    const { error: consumeError } = await supabaseClient.rpc("consumir_codigo_salida_manual", {
      p_id: state.manualAuthId,
      p_codigo: codigo,
      p_latitud: ubic?.latitud ?? null,
      p_longitud: ubic?.longitud ?? null,
      p_precision_m: ubic?.precision ?? null,
      p_foto_path: selfiePath,
      p_colaborador_id: String(colaborador.id),
      p_asistencia_id: String(insertedAttendance.id)
    });
    if (consumeError) {
      console.error("[SALIDA MANUAL] no se pudo consumir el codigo", consumeError);
    }

    await notifyManualAdminExitWebhook({
      colaborador,
      colaboradorCsv: csvCollaborator,
      entrada: last,
      salida: { fecha, hora, jornada: jornadaBuk },
      motivo,
      bukOk,
      bukResultado: bukData ?? { error: bukError?.message || "sin respuesta" },
      asistenciaId: insertedAttendance.id
    });

    if (!bukOk) {
      setMessage(elements.manualMessage, "Salida guardada, pero no se pudo enviar a Buk/Ctrlit. Administracion fue notificada.", "error");
    } else {
      setMessage(elements.manualMessage, "Salida manual registrada y enviada a Buk/Ctrlit. Administracion fue notificada.", "success");
    }

    elements.manualReasonInput.value = "";
    elements.manualReasonCategory.value = "";
    elements.manualDniInput.value = "";
    elements.manualDateInput.value = "";
    elements.manualTimeInput.value = "";
    resetManualSecureBlock();
    await loadAdminMarks();
    loadOpenTurns().catch(() => {});
  } catch (error) {
    setMessage(elements.manualMessage, error.message || "No se pudo registrar la salida manual.", "error");
  } finally {
    setBusy(elements.manualExitButton, false);
  }
}

async function ensureExistingCollaborator(csvCollaborator) {
  const { data } = await supabaseClient
    .from("colaboradores")
    .select("id,dni,nombre,empresa,contrato,especialidad,estado,obra_id,foto_referencia_path,rostro_enrolado,rostro_enrolado_at,obras(nombre,obra_id_externo)")
    .eq("dni", csvCollaborator.cedula)
    .maybeSingle();

  if (data) return data;
  return await ensureLocalCollaborator(csvCollaborator);
}

async function validateEnrollCollaborator() {
  if (!state.isAdmin) return;
  if (!requireOnline(elements.enrollMessage)) return;

  const dni = normalizeDni(elements.enrollDniInput.value);
  state.enrollCandidate = null;
  state.enrollColaborador = null;
  elements.enrollCameraButton.disabled = true;
  elements.deleteEnrollButton.disabled = true;
  elements.enrollPreviewBox.classList.add("hidden");
  elements.enrollPreviewImage.removeAttribute("src");

  if (!dni) {
    elements.enrollBox.className = "result-box muted";
    elements.enrollBox.textContent = "Digita la cedula del colaborador.";
    return;
  }

  const csvCollaborator = await findActiveCsvCollaborator(dni);
  if (!csvCollaborator) {
    elements.enrollBox.className = "result-box";
    elements.enrollBox.textContent = "La cedula no esta activa en la base de colaboradores.";
    setMessage(elements.enrollMessage, "No se puede enrolar un colaborador inactivo o inexistente.", "error");
    return;
  }

  const colaborador = await ensureExistingCollaborator(csvCollaborator);
  if (!colaborador) return;

  state.enrollCandidate = csvCollaborator;
  state.enrollColaborador = colaborador;
  elements.deleteEnrollButton.disabled = !colaborador.rostro_enrolado || !colaborador.foto_referencia_path;
  elements.enrollBox.className = "result-box";
  elements.enrollBox.innerHTML = `
    <strong>${escapeHtml(csvCollaborator.nombre || colaborador.nombre || "Colaborador")}</strong>
    <div>Cedula: ${escapeHtml(csvCollaborator.cedula)}</div>
    <div>Cargo: ${escapeHtml(csvCollaborator.cargo || "Sin cargo")}</div>
    <div>Rostro: ${colaborador.rostro_enrolado ? "enrolado" : "sin enrolar"}</div>
    <div>Estado: listo para capturar rostro de referencia.</div>
  `;
  elements.enrollCameraButton.disabled = false;
  await showEnrollReferencePreview(colaborador);
  setMessage(elements.enrollMessage, "Colaborador validado. Captura el rostro de referencia.", "success");
}

async function showEnrollReferencePreview(colaborador) {
  if (!colaborador.rostro_enrolado || !colaborador.foto_referencia_path) {
    elements.enrollPreviewBox.classList.add("hidden");
    elements.enrollPreviewImage.removeAttribute("src");
    return;
  }

  const { data, error } = await supabaseClient.storage
    .from("rostros-referencia")
    .createSignedUrl(colaborador.foto_referencia_path, 300);

  if (error || !data?.signedUrl) {
    elements.enrollPreviewBox.classList.add("hidden");
    return;
  }

  elements.enrollPreviewImage.src = data.signedUrl;
  elements.enrollPreviewBox.classList.remove("hidden");
}

async function saveReferenceFace(file) {
  if (!state.enrollColaborador || !state.enrollCandidate) {
    setMessage(elements.enrollMessage, "No hay colaborador validado para enrolar.", "error");
    return;
  }

  setMessage(elements.enrollMessage, "Guardando rostro de referencia...");

  const compressed = await compressImage(file, 720, 0.72);
  const path = `rostros/${state.enrollCandidate.cedula}/referencia-${Date.now()}.webp`;

  if (state.enrollColaborador.foto_referencia_path) {
    await supabaseClient.storage
      .from("rostros-referencia")
      .remove([state.enrollColaborador.foto_referencia_path]);
  }

  const { error: uploadError } = await supabaseClient.storage
    .from("rostros-referencia")
    .upload(path, compressed, {
      contentType: "image/webp",
      upsert: true
    });

  if (uploadError) {
    setMessage(elements.enrollMessage, uploadError.message || "No se pudo subir el rostro.", "error");
    return;
  }

  const { error: updateError } = await supabaseClient
    .from("colaboradores")
    .update({
      foto_referencia_path: path,
      rostro_enrolado: true,
      rostro_enrolado_at: new Date().toISOString()
    })
    .eq("id", state.enrollColaborador.id);

  if (updateError) {
    setMessage(elements.enrollMessage, updateError.message || "No se pudo actualizar el colaborador.", "error");
    return;
  }

  stopCamera();
  state.cameraMode = "attendance";
  elements.enrollCameraButton.disabled = true;
  elements.deleteEnrollButton.disabled = false;
  state.enrollColaborador = {
    ...state.enrollColaborador,
    foto_referencia_path: path,
    rostro_enrolado: true
  };
  await showEnrollReferencePreview(state.enrollColaborador);
  elements.enrollBox.className = "result-box";
  elements.enrollBox.innerHTML += "<div>Rostro de referencia enrolado correctamente.</div>";
  setMessage(elements.enrollMessage, "Rostro de referencia guardado correctamente.", "success");
}

async function deleteReferenceFace() {
  if (!state.isAdmin || !state.enrollColaborador) return;
  if (!state.enrollColaborador.rostro_enrolado || !state.enrollColaborador.foto_referencia_path) {
    setMessage(elements.enrollMessage, "Este colaborador no tiene rostro enrolado.", "error");
    return;
  }

  const ok = window.confirm("¿Eliminar el rostro enrolado de este colaborador?");
  if (!ok) return;

  setMessage(elements.enrollMessage, "Eliminando rostro enrolado...");
  elements.deleteEnrollButton.disabled = true;

  const path = state.enrollColaborador.foto_referencia_path;
  const { error: removeError } = await supabaseClient.storage
    .from("rostros-referencia")
    .remove([path]);

  if (removeError) {
    setMessage(elements.enrollMessage, removeError.message || "No se pudo eliminar la foto.", "error");
    elements.deleteEnrollButton.disabled = false;
    return;
  }

  const { error: updateError } = await supabaseClient
    .from("colaboradores")
    .update({
      foto_referencia_path: null,
      rostro_enrolado: false,
      rostro_enrolado_at: null
    })
    .eq("id", state.enrollColaborador.id);

  if (updateError) {
    setMessage(elements.enrollMessage, updateError.message || "No se pudo actualizar el colaborador.", "error");
    return;
  }

  state.enrollColaborador = {
    ...state.enrollColaborador,
    foto_referencia_path: null,
    rostro_enrolado: false,
    rostro_enrolado_at: null
  };
  elements.enrollPreviewBox.classList.add("hidden");
  elements.enrollPreviewImage.removeAttribute("src");
  elements.enrollBox.className = "result-box";
  elements.enrollBox.innerHTML += "<div>Rostro enrolado eliminado.</div>";
  setMessage(elements.enrollMessage, "Rostro enrolado eliminado correctamente.", "success");
}

elements.loginForm.addEventListener("submit", login);
elements.logoutButton.addEventListener("click", logout);
elements.registerTabButton.addEventListener("click", () => showTab("register"));
elements.historyTabButton.addEventListener("click", () => {
  showTab("history");
});
elements.base3TabButton?.addEventListener("click", () => showTab("base3"));
elements.adminTabButton.addEventListener("click", async () => {
  const ok = await requireAdminClave();
  if (ok) showTab("admin");
});
elements.manualExitTabButton?.addEventListener("click", () => showTab("manualexit"));
elements.searchButton.addEventListener("click", buscarColaborador);
elements.dniInput.addEventListener("input", scheduleDniValidation);
elements.dniInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    buscarColaborador();
  }
});
// Al salir del campo se pregunta sola si se guarda el numero. Si el foco se fue al
// boton Registrar no se pregunta aqui (el submit ya lo hace) para no comerse el clic.
elements.celularComprobanteInput?.addEventListener("blur", (event) => {
  if (event.relatedTarget?.id === "submitButton") return;
  preguntarGuardarCelular();
});
elements.puntualidadBuscarButton?.addEventListener("click", cargarPuntualidad);
elements.puenteResolverButton?.addEventListener("click", resolverNombresProgramacion);
elements.jornadasBuscarButton?.addEventListener("click", cargarJornadasAnomalas);
elements.jornadasExportButton?.addEventListener("click", exportarJornadasCsv);
elements.jornadasDetalle?.addEventListener("click", (event) => {
  const btn = event.target.closest(".jornada-corregir");
  if (!btn) return;
  corregirDesdeError(btn.dataset.dni, btn.dataset.fecha);
});
elements.horarioBuscarButton?.addEventListener("click", cargarHorario);
elements.horarioExportButton?.addEventListener("click", exportarHorarioCsv);
elements.base3BuscarButton?.addEventListener("click", cargarBase3);
elements.base3ExportButton?.addEventListener("click", exportarBase3Csv);
elements.mapaBuscarButton?.addEventListener("click", cargarMapaMarcas);
elements.mapaBuscarInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); cargarMapaMarcas(); }
});
elements.horarioBuscarInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); cargarHorario(); }
});
elements.jornadasFiltros?.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-jornada-filtro]");
  if (!chip) return;
  state.jornadasFiltro = chip.dataset.jornadaFiltro || "";
  renderJornadasAnomalas();
});
elements.verificadorBuscarButton?.addEventListener("click", cargarVerificador);
elements.verificadorDiaButton?.addEventListener("click", cargarVerificadorDia);
elements.verificadorDesfasesButton?.addEventListener("click", cargarVerificadorDesfases);
// El banner de "falta cerrar el turno" trae el boton para retomar la declaracion:
// se bloqueo la entrada, pero la salida siempre queda a un clic de distancia.
elements.programacionBanner?.addEventListener("click", async (event) => {
  if (!event.target.closest("#cierrePendienteButton")) return;
  const cerrado = await ofrecerCierreTurnoAnterior(state.sentidoSegunProgramacion);
  if (cerrado) {
    state.nextSentido = "entrada";
    renderSentidoSelector();
    renderProgramacionBanner();
    renderTurnoStatusBanner();
  }
});

elements.verificadorGestoresButton?.addEventListener("click", cargarVerificadorGestores);
elements.verificadorCierresButton?.addEventListener("click", cargarVerificadorCierres);
elements.verificadorExcedidasButton?.addEventListener("click", cargarVerificadorExcedidas);
elements.verificadorNovedadesButton?.addEventListener("click", cargarVerificadorNovedades);
elements.verificadorExportButton?.addEventListener("click", exportarVerificadorCsv);
elements.verificadorFiltrarButton?.addEventListener("click", () => rerenderVerificador());
// Al cambiar una fecha se vuelve a consultar sola, respetando el modo activo, para
// que la tabla no quede con el rango anterior.
[elements.verificadorDesdeInput, elements.verificadorHastaInput].forEach((inp) => {
  inp?.addEventListener("change", () => {
    clampFechaVerificador(inp);
    if (!state.verificadorLoaded) return;
    if (state.verificadorModo === "dia") cargarVerificadorDia();
    else if (state.verificadorModo === "desfases") cargarVerificadorDesfases();
    else if (state.verificadorModo === "gestores") cargarVerificadorGestores();
    else if (state.verificadorModo === "cierres") cargarVerificadorCierres();
    else if (state.verificadorModo === "excedidas") cargarVerificadorExcedidas();
    else if (state.verificadorModo === "novedades") cargarVerificadorNovedades();
    else cargarVerificador();
  });
});
elements.verificadorBuscarInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); rerenderVerificador(); }
});
// Filtra en vivo mientras se escribe (sin tener que dar clic ni Enter).
elements.verificadorBuscarInput?.addEventListener("input", () => {
  if (state.verificadorData || state.verificadorDiaData) rerenderVerificador();
});
elements.verificadorFiltros?.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-verif-filtro]");
  if (!chip) return;
  state.verificadorFiltro = chip.dataset.verifFiltro || "";
  renderVerificador();
});
elements.verificadorDetalle?.addEventListener("click", (event) => {
  // Botón de eliminar: borra esa marca (entrada o salida).
  const del = event.target.closest(".verif-borrar");
  if (del) {
    borrarMarcaVerificador(del.closest(".verif-row"), del.dataset.sentido);
    return;
  }
  // Botón del reloj: abre el selector nativo de hora.
  const pick = event.target.closest(".verif-hora-pick");
  if (pick) {
    const wrap = pick.parentElement;
    const nativo = wrap.querySelector(".verif-hora-native");
    const texto = wrap.querySelector(".verif-hora");
    if (nativo) {
      const norm = normalizeHoraInput(texto?.value); // parte del valor ya escrito
      if (norm) nativo.value = norm;
      if (typeof nativo.showPicker === "function") {
        try { nativo.showPicker(); } catch (e) { nativo.focus(); }
      } else {
        nativo.focus();
        nativo.click();
      }
    }
    return;
  }
  const btn = event.target.closest(".verif-guardar");
  if (!btn) return;
  guardarHorasVerificador(btn.closest(".verif-row"));
});
// Al elegir en el reloj, copia la hora (24 h) al campo de texto.
elements.verificadorDetalle?.addEventListener("change", (event) => {
  const nativo = event.target.closest?.(".verif-hora-native");
  if (!nativo || !nativo.value) return;
  const texto = nativo.parentElement.querySelector(".verif-hora");
  if (texto) texto.value = nativo.value;
});
// Al salir de un campo de texto de hora se reformatea a HH:MM (ej. "2338" -> "23:38").
elements.verificadorDetalle?.addEventListener("focusout", (event) => {
  const inp = event.target.closest?.(".verif-hora");
  if (!inp || inp.disabled || inp.classList.contains("verif-hora-native")) return;
  const norm = normalizeHoraInput(inp.value);
  if (norm) inp.value = norm;
});
// Si vuelven a editar una fila ya guardada, se quita el check para poder re-guardar.
elements.verificadorDetalle?.addEventListener("input", (event) => {
  const inp = event.target.closest?.(".verif-hora");
  if (!inp) return;
  const row = inp.closest(".verif-row");
  if (row?.classList.contains("verif-guardado")) {
    row.classList.remove("verif-guardado");
    const b = row.querySelector(".verif-guardar");
    if (b) { b.classList.remove("ok"); b.textContent = "Guardar"; }
  }
});
elements.cameraButton.addEventListener("click", startCamera);
elements.locationButton.addEventListener("click", captureCurrentLocation);

// Menos pasos: tocar la caja de ubicacion (estado o el recuadro del mapa cuando
// aun esta vacio) activa el GPS sin tener que buscar el boton "Activar ubicacion".
// Si el mapa de Leaflet ya existe, no interceptamos el toque (deja mover el mapa).
function activarUbicacionSiFalta() {
  if (state.currentLocation) return;
  captureCurrentLocation();
}
elements.locationStatus?.addEventListener("click", activarUbicacionSiFalta);
elements.locationMap?.addEventListener("click", () => {
  if (!state.locationMap) activarUbicacionSiFalta();
});

// Tutorial "¿Cómo marcar?"
elements.tutorialButton?.addEventListener("click", openTutorial);
elements.tutorialClose?.addEventListener("click", closeTutorial);
elements.tutorialNext?.addEventListener("click", tutorialNext);
elements.tutorialPrev?.addEventListener("click", tutorialPrev);
elements.tutorialOverlay?.addEventListener("click", (event) => {
  if (event.target === elements.tutorialOverlay) closeTutorial();
});

// TEMPORAL (pruebas): botón de eliminar marca en el panel de administración.
// Aplica a las dos tablas que muestran marcas: "Marcas" y "Ingresos y salidas".
function onEliminarMarcaClick(event) {
  const btn = event.target.closest(".journey-del");
  if (!btn) return;
  eliminarMarcaPrueba(btn.getAttribute("data-del-id"), btn.getAttribute("data-del-label") || "esta marca");
}
elements.adminMarksBody?.addEventListener("click", onEliminarMarcaClick);
elements.journalBody?.addEventListener("click", onEliminarMarcaClick);
elements.vehicleInput.addEventListener("input", () => {
  updateVehicleHint();
  if (state.isDriverCandidate) renderAttendanceDriverBox();
});
elements.baseInput.addEventListener("input", () => {
  if (elements.baseInput.value.trim()) elements.baseInput.classList.remove("invalid");
});
elements.vehicleInput.addEventListener("change", () => {
  updateVehicleHint();
  if (state.isDriverCandidate) renderAttendanceDriverBox();
});
elements.captureButton.addEventListener("click", capturePhoto);
elements.stopCameraButton.addEventListener("click", stopCamera);
elements.overdueDriversToastClose.addEventListener("click", dismissOverdueDriversToast);
elements.overdueDriversToastGo.addEventListener("click", () => {
  dismissOverdueDriversToast();
  showTab("admin");
  showAdminSubtab("alerts");
  document.getElementById("overdueTurnsPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
});
elements.adminSubtabs?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-admin-tab]");
  if (!btn) return;
  showAdminSubtab(btn.dataset.adminTab);
});
elements.attendanceForm.addEventListener("submit", submitAttendance);
elements.reportDateInput.addEventListener("input", () => {
  state.reportDateTouched = true;
  refrescarPorFechaReporte();
});
elements.reportTimeInput.addEventListener("input", () => {
  state.reportTimeTouched = true;
  refrescarPorFechaReporte();
});
elements.sentidoEntradaButton.addEventListener("click", () => cambiarSentidoManual("entrada"));
elements.sentidoSalidaButton.addEventListener("click", () => cambiarSentidoManual("salida"));
elements.refreshButton.addEventListener("click", refreshCurrentHistory);
elements.historySearchButton.addEventListener("click", refreshCurrentHistory);
elements.historyDniInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    refreshCurrentHistory();
  }
});
elements.historyStartDateInput.addEventListener("change", () => {
  state.historyPage = 1;
});
elements.historyEndDateInput.addEventListener("change", () => {
  state.historyPage = 1;
});
elements.historyPrevPageButton.addEventListener("click", () => {
  state.historyPage = Math.max(1, state.historyPage - 1);
  refreshCurrentHistory("keep-page");
});
elements.historyNextPageButton.addEventListener("click", () => {
  state.historyPage += 1;
  refreshCurrentHistory("keep-page");
});
elements.historyList.addEventListener("click", (event) => {
  const btn = event.target.closest(".history-photo-btn");
  if (!btn) return;
  showPhotoModal(btn.dataset.foto, btn.dataset.label);
});
elements.photoModalClose?.addEventListener("click", hidePhotoModal);
elements.alertButton.addEventListener("click", async () => {
  hideAlertModal();
  const registerVisible = !elements.registerPanel.classList.contains("hidden");
  if (state.csvCandidate && registerVisible) {
    await startCamera();
  }
});
elements.registroSuccessButton.addEventListener("click", hideRegistroModal);
elements.openTurnsReloadButton.addEventListener("click", loadOpenTurns);
elements.openTurnsExportButton.addEventListener("click", exportOpenTurnsToCSV);
elements.overdueTurnsExportButton.addEventListener("click", exportOverdueTurnsToCSV);
elements.openTurnsSearchInput.addEventListener("input", () => renderOpenTurns());
elements.openTurnsCargoFilter.addEventListener("change", () => renderOpenTurns());
elements.reloadCsvButton.addEventListener("click", loadCollaboratorsCsv);
elements.csvSearchInput.addEventListener("input", renderCsvTable);
elements.reloadPerfilSocioButton?.addEventListener("click", loadPerfilSociodemografico);
elements.perfilSocioSearchInput?.addEventListener("input", renderPerfilSocioTable);
elements.perfilSocioBody?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-ver-perfil-socio]");
  if (!btn) return;
  abrirDetallePerfilSocio(btn.dataset.verPerfilSocio);
});
elements.perfilSocioDetailClose?.addEventListener("click", cerrarDetallePerfilSocio);
elements.perfilSocioDetailOverlay?.addEventListener("click", (event) => {
  if (event.target === elements.perfilSocioDetailOverlay) cerrarDetallePerfilSocio();
});
elements.manualExitForm.addEventListener("submit", registerManualExit);
elements.manualCodeButton?.addEventListener("click", manualRequestCode);
elements.manualLocationButton?.addEventListener("click", manualCaptureLocation);
elements.manualCameraButton?.addEventListener("click", manualStartCamera);
elements.manualCaptureButton?.addEventListener("click", manualCapturePhoto);
elements.manualCameraCancelButton?.addEventListener("click", stopManualCamera);
elements.manualPhotoRetakeButton?.addEventListener("click", manualStartCamera);
// Al completar el codigo (6 digitos), abre la camara sola para tomar la selfie.
elements.manualCodeInput?.addEventListener("input", () => {
  if (elements.manualCodeInput.value.trim().length === 6) maybeAutoOpenManualCamera();
});
elements.sonarAdminForm.addEventListener("submit", assignSonarDriverManually);
elements.loadSonarDriversButton.addEventListener("click", loadSonarDrivers);
elements.sonarDriverSearchInput.addEventListener("input", renderSonarDriverOptions);
elements.sonarDriverSelect.addEventListener("change", () => {
  state.selectedSonarDriverId = elements.sonarDriverSelect.value || null;
  renderSonarDriverSelectedLabel();
  updateSonarSelectionBox();
});
elements.sonarDriverList.addEventListener("click", (event) => {
  const item = event.target.closest(".sonar-driver-item[data-driver-id]");
  if (!item) return;
  selectSonarDriver(item.dataset.driverId);
});
elements.sonarVehicleSelect.addEventListener("change", updateSonarSelectionBox);
elements.reloadMarksButton.addEventListener("click", loadAdminMarks);
elements.adminDniSearchInput.addEventListener("input", () => {
  state.adminPage = 1;
  renderAdminMarks();
});
elements.adminDateFromInput.addEventListener("change", () => {
  state.adminPage = 1;
  loadAdminMarks();
});
elements.adminDateToInput.addEventListener("change", () => {
  state.adminPage = 1;
  loadAdminMarks();
});
elements.adminNameSearchInput.addEventListener("input", () => {
  state.adminPage = 1;
  renderAdminMarks();
});
elements.adminCargoFilter.addEventListener("change", () => {
  state.adminPage = 1;
  renderAdminMarks();
});
elements.adminPrevPageButton.addEventListener("click", () => {
  state.adminPage = Math.max(1, state.adminPage - 1);
  renderAdminMarks();
});
elements.adminNextPageButton.addEventListener("click", () => {
  state.adminPage += 1;
  renderAdminMarks();
});
elements.reloadJournalButton.addEventListener("click", () => {
  state.journalPage = 1;
  loadJournalMarks();
});
elements.exportJournalButton.addEventListener("click", exportJournalToCsv);
elements.journalSearchInput.addEventListener("input", () => {
  state.journalPage = 1;
  renderJournalMarks();
});
elements.journalCargoFilter.addEventListener("change", () => {
  state.journalPage = 1;
  renderJournalMarks();
});
elements.journalDateFromInput.addEventListener("change", () => {
  state.journalPage = 1;
  loadJournalMarks();
});
elements.journalDateToInput.addEventListener("change", () => {
  state.journalPage = 1;
  loadJournalMarks();
});
elements.journalPrevPageButton.addEventListener("click", () => {
  state.journalPage = Math.max(1, state.journalPage - 1);
  renderJournalMarks();
});
elements.journalNextPageButton.addEventListener("click", () => {
  state.journalPage += 1;
  renderJournalMarks();
});
elements.reloadRechazoButton.addEventListener("click", () => {
  state.rechazoPage = 1;
  loadRechazoMarks();
});
elements.exportRechazoButton.addEventListener("click", exportRechazoToCsv);
elements.resendAllRechazoButton?.addEventListener("click", reenviarTodasRechazo);
elements.corregirBuscarButton?.addEventListener("click", buscarCorregir);
elements.corregirDniInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); buscarCorregir(); }
});
elements.corregirResultado?.addEventListener("click", (event) => {
  const guardar = event.target.closest(".corregir-guardar");
  if (guardar) { guardarCorreccionMarca(guardar.getAttribute("data-id")); return; }
  const borrar = event.target.closest(".corregir-borrar");
  if (borrar) { borrarMarcaCorregir(borrar.getAttribute("data-id")); }
});
elements.rechazoBody?.addEventListener("click", (event) => {
  const btn = event.target.closest(".rechazo-resend");
  if (!btn) return;
  btn.disabled = true;
  onReenviarUnaMarca(btn.getAttribute("data-resend-id"));
});
elements.rechazoSearchInput.addEventListener("input", () => {
  state.rechazoPage = 1;
  renderRechazoMarks();
});
elements.rechazoDateFromInput.addEventListener("change", () => {
  state.rechazoPage = 1;
  loadRechazoMarks();
});
elements.rechazoDateToInput.addEventListener("change", () => {
  state.rechazoPage = 1;
  loadRechazoMarks();
});
elements.rechazoPrevPageButton.addEventListener("click", () => {
  state.rechazoPage = Math.max(1, state.rechazoPage - 1);
  renderRechazoMarks();
});
elements.rechazoNextPageButton.addEventListener("click", () => {
  state.rechazoPage += 1;
  renderRechazoMarks();
});
elements.reloadInconsistButton.addEventListener("click", loadInconsistMarks);
elements.exportInconsistButton.addEventListener("click", exportInconsistToCsv);
elements.inconsistSearchInput.addEventListener("input", renderInconsistencias);
elements.inconsistDateFromInput.addEventListener("change", loadInconsistMarks);
elements.inconsistDateToInput.addEventListener("change", loadInconsistMarks);
elements.reloadSinMarcaButton?.addEventListener("click", loadSinMarca);
elements.exportSinMarcaButton?.addEventListener("click", exportSinMarcaToCsv);
elements.sinMarcaSearchInput?.addEventListener("input", renderSinMarca);
elements.sinMarcaDaysInput?.addEventListener("change", loadSinMarca);
elements.sinMarcaMaxBioInput?.addEventListener("change", loadSinMarca);
elements.reloadValidacionButton?.addEventListener("click", loadValidacionTurnos);
elements.exportValidacionButton?.addEventListener("click", exportValidacionToCsv);
elements.validacionSearchInput?.addEventListener("input", renderValidacion);
elements.validacionFiltroTipo?.addEventListener("change", renderValidacion);
elements.validacionResumen?.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-filtro]");
  if (!chip) return;
  elements.validacionFiltroTipo.value = chip.dataset.filtro;
  renderValidacion();
});
elements.validacionDateFromInput?.addEventListener("change", loadValidacionTurnos);
elements.validacionDateToInput?.addEventListener("change", loadValidacionTurnos);
elements.validacionMaxHorasInput?.addEventListener("change", loadValidacionTurnos);
elements.inconsistBody.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-del-mark]");
  if (!button) return;
  eliminarMarcaInconsistente({
    id: button.dataset.delMark,
    dni: button.dataset.dni,
    fecha: button.dataset.fecha,
    hora: button.dataset.hora,
    sentido: button.dataset.sentido,
    buk: button.dataset.buk
  });
});
elements.enrollValidateButton.addEventListener("click", validateEnrollCollaborator);
elements.enrollCameraButton.addEventListener("click", startEnrollCamera);
elements.deleteEnrollButton.addEventListener("click", deleteReferenceFace);
elements.csvTableBody.addEventListener("click", (event) => {
  const button = event.target.closest("[data-use-dni]");
  if (button) useCsvDni(button.dataset.useDni);
});

init();

(function registrarServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  // PORTAL: service worker desactivado cuando vamos embebidos.
  // Dentro del Portal del Conductor este módulo comparte scope con el service
  // worker del portal, que ya precachea nuestros archivos. Registrar el
  // nuestro además haría que ambos se pisaran las cachés y dejaría versiones
  // viejas pegadas. Abierto suelto (fuera del iframe) sigue funcionando igual.
  if (window.parent !== window) return;

  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { scope: "./" })
      .then((reg) => {
        if (reg.waiting && navigator.serviceWorker.controller) {
          mostrarBannerActualizacion(reg);
        }

        reg.addEventListener("updatefound", () => {
          const nuevoSw = reg.installing;
          if (!nuevoSw) return;
          nuevoSw.addEventListener("statechange", () => {
            if (nuevoSw.state === "installed" && navigator.serviceWorker.controller) {
              mostrarBannerActualizacion(reg);
            }
          });
        });

        reg.update().catch(() => {});
        setInterval(() => { reg.update().catch(() => {}); }, 5 * 60 * 1000);

        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") {
            reg.update().catch(() => {});
          }
        });
      })
      .catch((error) => console.warn("[PWA] no se pudo registrar SW", error));

    let recargandoPorSw = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (recargandoPorSw) return;
      recargandoPorSw = true;
      window.location.reload();
    });
  });
})();

function mostrarBannerActualizacion(reg) {
  const banner = document.getElementById("updateBanner");
  const boton = document.getElementById("updateBannerButton");
  if (!banner || !boton) return;
  banner.classList.remove("hidden");
  boton.onclick = () => {
    if (reg.waiting) {
      reg.waiting.postMessage({ type: "SKIP_WAITING" });
    } else {
      window.location.reload();
    }
  };
}

(function configurarInstalacionPWA() {
  let deferredPrompt = null;
  const boton = document.getElementById("installPwaButton");

  const yaInstaladaStandalone = () =>
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;

  if (yaInstaladaStandalone()) {
    if (boton) boton.classList.add("hidden");
    return;
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    if (boton) boton.classList.remove("hidden");
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    if (boton) boton.classList.add("hidden");
  });

  if (boton) {
    boton.addEventListener("click", async () => {
      if (!deferredPrompt) return;
      try {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === "accepted") {
          boton.classList.add("hidden");
        }
      } catch (error) {
        console.warn("[PWA] no se pudo mostrar prompt de instalacion", error);
      } finally {
        deferredPrompt = null;
      }
    });
  }
})();
