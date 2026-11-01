/**
 * tkinter_wasm.js — reusable initialisation module for tkinter-wasm.
 *
 * Usage (ESM):
 *
 *   import { initialize } from "./tkinter_wasm.js";
 *
 *   const api = await initialize(
 *     document.getElementById("tk-root"),   // rootElement
 *     "build/",                              // loadPath
 *     {
 *       pyodideUrl: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.js",
 *       wheelUrl:   "build/tkinter_wasm-0.1.0-py3-none-any.whl"
 *     }
 *   );
 *
 *   // api.runPython(code)  — run a Python string, returns a Promise
 *   // api.runTclTk(code)   — evaluate a Tcl/Tk script directly, returns result string
 *   // api.pyodide          — the raw Pyodide instance
 *   // api.tkinter_wasm     — the _tkinter_wasm bridge object
 *
 * initialize() resolves only after BOTH tcltk.wasm and Pyodide (including
 * the tkinter-wasm wheel) are fully loaded and ready.  The hosting page can
 * start executing Python code immediately after the promise resolves.
 *
 * loadPath is the base URL / path prefix used to locate all build artifacts:
 *   - tcltk.js / tcltk.wasm
 *   - tkinter_wasm wheel
 *
 * rootElement is passed to tcltk.wasm as the DOM container for Tk windows
 * (x11WasmRoot).  It must already exist in the DOM when initialize() is called.
 */

"use strict"

// ---------------------------------------------------------------------------
// Embedded Tcl / Python scripts
// ---------------------------------------------------------------------------
// Script bodies that the module runs via tclEval / bridge.eval /
// pyodide.runPython.  They are kept here as named constants so the runnable
// code lives in one place and the calling functions stay compact.  Content
// is preserved verbatim — only the storage location changes.

const BOOTSTRAP_TCL_NAMESPACE_TCL_SCRIPT = `
namespace eval ::_tkinter_wasm {}
set ::_tkinter_wasm::cbQueue {}
proc ::_tkinter_wasm::dispatch {name args} {
    lappend ::_tkinter_wasm::cbQueue [concat [list $name] $args]
    return {}
}
`

const HIDE_ROOT_WINDOW_TCL_SCRIPT = `
wm geometry . 0x0+0+0;
wm withdraw .
`

const RESET_CALLBACKS_TCL_SCRIPT = `
foreach info [after info] { after cancel [lindex $info 0] }
foreach v [info globals PY_VAR*] { catch { unset $v } }
set ::_tkinter_wasm::cbQueue {}
`

const DESTROY_TK_WINDOWS_TCL_SCRIPT = `
foreach w [winfo children .] { if {[string match "._tkinter_wasm_tk_*" $w]} { destroy $w } }
`

// TODO verify, is this still needed:
const UNIMPORT_TKINTER_MODULES_PYTHON_SCRIPT = `
import sys, importlib
for mod in list(sys.modules.keys()):
    if mod == "_tkinter" or mod == "tkinter" or mod.startswith("tkinter."):
        del sys.modules[mod]
importlib.invalidate_caches()
`

const EXPOSE_BRIDGE_PYTHON_SCRIPT = `
import js
import builtins
builtins._tkinter_wasm = js._tkinter_wasm
`

// TKINTER-WASM: Python function that unconditionally sets the
// _tkinter_wasm_quit_main_loop flag in the running _tkinter module.
// Relevancy check (executionId match) is done on the JS side before calling.
// The PyProxy is kept in a JS-local closure variable; not exposed on the
// bridge or builtins.
const CREATE_QUIT_MAIN_LOOP_PYTHON_SCRIPT = `
import sys
def _tkinter_wasm_quit_main_loop():
    tkinter_mod = sys.modules.get("_tkinter")
    if tkinter_mod is not None:
        tkinter_mod._tkinter_wasm_quit_main_loop = True
`

const CREATE_GET_LAST_ERROR_PYTHON_SCRIPT = `
import sys
import builtins
def _tkinter_wasm_get_last_execution_error():
    import traceback
    from pyodide.ffi import to_js
    import js
    if sys.last_type is None:
        return js.null
    tb = sys.last_traceback
    error_file = None
    error_line = None
    # Walk traceback to find the innermost frame from "main.py"
    current = tb
    while current is not None:
        frame = current.tb_frame
        filename = frame.f_code.co_filename
        if filename == "main.py" or filename.endswith("/main.py"):
            error_file = filename
            error_line = current.tb_lineno
        current = current.tb_next
    if error_file is None or error_line is None:
        return js.null
    error_message = "".join(
        traceback.format_exception(sys.last_type, sys.last_value, sys.last_traceback)
    )
    error_type = sys.last_type.__name__ if sys.last_type is not None else None
    if error_type is None:
        return js.null
    execution_id = _tkinter_wasm.executionId
    return to_js({
        "executionId": execution_id,
        "errorType": error_type,
        "errorMessage": error_message,
        "errorFile": error_file,
        "errorLine": error_line,
    })

#builtins._tkinter_wasm_get_last_execution_error = _tkinter_wasm_get_last_execution_error
`

const REDIRECT_PYTHON_OUTPUT_PYTHON_SCRIPT = `
import sys
class _TkinterWasmStream:
    def __init__(self, is_stderr=False):
        self._err = is_stderr
        self._line = []
    def _emit(self, line):
        handler = _tkinter_wasm.writeErrorHandler if self._err else _tkinter_wasm.writeOutputHandler
        if handler is not None:
            handler(line)
    def write(self, s):
        s = str(s)
        for ch in s:
            if ch == '\\n':
                self._line.append(ch)
                line = ''.join(self._line)
                self._line = []
                self._emit(line)
            else:
                self._line.append(ch)
    def flush(self):
        if self._line:
            line = ''.join(self._line)
            self._line = []
            self._emit(line)
sys.stdout = _TkinterWasmStream()
sys.stderr = _TkinterWasmStream(is_stderr=True)
`;

// ---------------------------------------------------------------------------
// Minimal Tcl list parser (JS side)
// Used to parse the callback-dispatch queue; not a full Tcl parser.
// ---------------------------------------------------------------------------

/** Split a Tcl list string into an Array of strings.
 *  Handles: bare words, {braced strings}, "quoted strings". */
function splitTclList(s) {
  const result = [];
  let i = 0;
  s = String(s).trim();
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let elem = "";
    if (s[i] === "{") {
      let depth = 0;
      i++;
      const start = i;
      while (i < s.length) {
        if (s[i] === "{") depth++;
        else if (s[i] === "}") {
          if (depth === 0) { elem = s.slice(start, i); i++; break; }
          depth--;
        }
        i++;
      }
    } else if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\") i++;
        elem += s[i++];
      }
      if (i < s.length) i++;
    } else {
      while (i < s.length && !/\s/.test(s[i])) elem += s[i++];
    }
    result.push(elem);
  }
  return result;
}

/** Quote an arbitrary string for safe embedding in a Tcl script as a
 *  single word.  Brace-quoting is preferred; backslash-quoting as fallback. */
function tclQuote(s) {
  s = String(s);
  let depth = 0;
  let balanced = true;
  for (const ch of s) {
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth < 0) { balanced = false; break; } }
  }
  if (depth !== 0) balanced = false;

  if (balanced && !s.includes("\\")) {
    return "{" + s + "}";
  }
  return '"' + s.replace(/\\/g, "\\\\")
                .replace(/"/g, '\\"')
                .replace(/\[/g, "\\[")
                .replace(/\$/g, "\\$")
                .replace(/\n/g, "\\n")
                .replace(/\r/g, "\\r")
                .replace(/\t/g, "\\t") + '"';
}

// ---------------------------------------------------------------------------
// Low-level WASM helpers
// ---------------------------------------------------------------------------


const encoder = new TextEncoder();

/** Write a JS string into the WASM heap as a null-terminated UTF-8 C string.
 *  Returns the WASM pointer; caller must _free() it. */
function writeCString(text) {
  const module = globalThis.Module;
  const malloc = module._malloc;
  if (!malloc) throw new Error("_tkinter_wasm: malloc not available");
  const memory = module._tkinter_wasm_wasmMemory
  if (!memory) throw new Error("_tkinter_wasm: WASM memory not captured");
  const heap = new Uint8Array(memory.buffer);
  const bytes = encoder.encode(text);
  const ptr = malloc(bytes.length + 1);
  if (!ptr) throw new Error("_tkinter_wasm: malloc failed");
  heap.set(bytes, ptr);
  heap[ptr + bytes.length] = 0;
  return ptr;
}

/** Evaluate a Tcl script via Module._TkBrowserEval.
 *  Returns the result string; throws a JS Error (with .tclCode) on TCL_ERROR. */
function tclEval(script) {
  const module = globalThis.Module;
  const evalFn = module._TkBrowserEval;
  const free = module._free;
  let ptr = 0;
  try {
    ptr = writeCString(script);
    const code = evalFn(ptr);
    const result = String(module.tkBrowserEvalResult || "");
    if (code !== 0) {
      const err = new Error(result);
      err.tclCode = code;
      throw err;
    }
    return result;
  } finally {
    if (ptr && typeof free === "function") free(ptr);
  }
}

// ---------------------------------------------------------------------------
// _tkinter_wasm bridge object factory
// ---------------------------------------------------------------------------

function createBridge() {
  /** Map from command name → Python callable (Pyodide PyProxy). */
  const _commandRegistry = Object.create(null);

  const bridge = {
    executionId: null,
    rootWindowPath: null,

    writeOutputHandler: null,
    writeErrorHandler: null,
    executionErrorHandler: null,

    /** Evaluate a Tcl script.  Returns result string.
     *  Throws JS Error (with .tclCode) on TCL_ERROR. */
    eval(script) {
      return tclEval(String(script));
    },

    /** Split a Tcl list string into a JS Array of strings. */
    splitlist(s) {
      tclEval("set ::_tkinter_wasm::_sl_tmp " + tclQuote(String(s)));
      const lenStr = tclEval("llength $::_tkinter_wasm::_sl_tmp");
      const n = parseInt(lenStr, 10);
      if (isNaN(n) || n === 0) return [];
      const result = [];
      for (let i = 0; i < n; i++) {
        result.push(tclEval("lindex $::_tkinter_wasm::_sl_tmp " + i));
      }
      return result;
    },

    /** Register a Python callable as a Tcl command. */
    createcommand(name, pyCallback) {
      name = String(name);
      _commandRegistry[name] = pyCallback;
      const quotedName = tclQuote(name);
      tclEval([
        "proc " + quotedName + " {args} {",
        "    ::_tkinter_wasm::dispatch " + quotedName + " {*}$args",
        "}",
      ].join("\n"));
    },

    /** Remove a Tcl command registered with createcommand. */
    deletecommand(name) {
      name = String(name);
      delete _commandRegistry[name];
      try { tclEval("rename " + tclQuote(name) + " {}"); }
      catch (_) { /* ignore if already gone */ }
    },

    /** Reset the command registry and callback queue.
     *  TKINTER-WASM: Called by resetEnvironment before destroying toplevels
     *  to prevent stale Python callbacks from referencing destroyed widgets.
     *
     *  Without this, variable traces from the previous run (registered via
     *  tk.Variable.trace_add) remain active on PY_VAR* Tcl variables.  When
     *  tkinter is reimported, the module-level _varnum counter resets to 0,
     *  so the new run recreates PY_VAR0, PY_VAR1, … with the same names as
     *  the previous run.  Writing to those variables triggers the old traces,
     *  which invoke old Python closures referencing now-destroyed widgets,
     *  producing "invalid command name" Tcl errors.
     *
     *  reset() clears, in order:
     *    1. All Tcl procs created by createcommand (Python callback wrappers)
     *    2. The JS-side _commandRegistry (so drainCallbacks finds no callbacks)
     *    3. All pending [after] timers (they reference the deleted procs)
     *    4. All PY_VAR* global variables (unsetting removes their traces)
     *    5. The ::_tkinter_wasm::cbQueue (pending callback records) */
    reset() {
      // 1+2. Delete all registered Tcl procs and clear the Python callback
      // registry.  After this, drainCallbacks() will find no matching
      // callbacks even if a trace somehow still fires.
      for (const name of Object.keys(_commandRegistry)) {
        try { tclEval("rename " + tclQuote(name) + " {}"); }
        catch (_) { /* ignore if already gone */ }
        delete _commandRegistry[name];
      }
      // 3+4+5. Cancel pending after timers, unset PY_VAR variables (removing
      // their traces), and clear the callback queue — all in one Tcl eval.
      try {
        tclEval(RESET_CALLBACKS_TCL_SCRIPT);
      } catch (_) { /* ignore — bootstrap namespace may not exist yet */ }
    },

    /** Drain the Tcl callback queue: call all pending Python callbacks
     *  synchronously.  Returns the number of callbacks dispatched. */
    drainCallbacks() {
      let count = 0;
      let iterations = 0;
      // Cap iterations to prevent infinite loops (matches C's limit of 100).
      while (iterations++ < 100) {
        let queue;
        try {
          queue = tclEval("set ::_tkinter_wasm::cbQueue");
        } catch (_) { break; }
        if (!queue || queue.trim() === "") break;
        try { tclEval("set ::_tkinter_wasm::cbQueue {}"); } catch (_) {}
        const records = splitTclList(queue);
        for (const record of records) {
          const parts = splitTclList(record);
          if (parts.length === 0) continue;
          const cmdName = parts[0];
          const args = parts.slice(1);
          const cb = _commandRegistry[cmdName];
          if (typeof cb !== "undefined") {
            try {
              cb(...args);
            } catch (err) {
              console.error("[tkinter-wasm/drainCallbacks]", err);
            }
          }
          count++;
        }
      }
      return count;
    },

    /** Pump Tcl/X11 events once (mirrors Tcl_DoOneEvent(DONT_WAIT)). */
    serviceEvents() {
      const svc = globalThis.Module._TkBrowserServiceUserActivationEvents;
      if (typeof svc === "function") svc();
    },

    // Expose helpers for Python-side use
    _tclQuote: tclQuote,
    _splitTclList: splitTclList,
  };

  return bridge;
}

// ---------------------------------------------------------------------------
// TextDecoder workaround. Safe to call multiple times
// ---------------------------------------------------------------------------

function installTextDecoderWorkaroundIdempotent() {
  const NativeTextDecoder = globalThis.TextDecoder;
  if (typeof NativeTextDecoder !== "function") return;
  // Idempotency guard: without this, every call would wrap the (already
  // wrapped) global TextDecoder again, growing the prototype chain
  // indefinitely. We tag the wrapper with a non-enumerable static property and
  // bail out when a previously installed wrapper is detected. The marker lives
  // on the class itself, so no module-level state is required.
  if (NativeTextDecoder._tkinterWasmTextDecoderWorkaround) return;
  function copyBufferSource(input) {
    if (ArrayBuffer.isView(input))
      return Uint8Array.from(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    if (input instanceof ArrayBuffer) return input.slice(0);
    return input;
  }
  globalThis.TextDecoder = class TextDecoder extends NativeTextDecoder {
    decode(input, options) {
      try { return super.decode(input, options); }
      catch (error) {
        if (!/resizable/i.test(String(error && error.message))) throw error;
        return super.decode(copyBufferSource(input), options);
      }
    }
  };
  Object.defineProperty(globalThis.TextDecoder, "_tkinterWasmTextDecoderWorkaround", {
    value: true,
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

// ---------------------------------------------------------------------------
// tcltk.wasm Module configuration
// ---------------------------------------------------------------------------

/**
 * Configure the Emscripten Module object for tcltk.wasm and return a Promise
 * that resolves once postRun fires (i.e. the Tcl interpreter is live).
 *
 * @param {Element}  rootElement  - DOM element to use as the Tk window container
 * @param {string}   loadPath     - Base path for build artifacts (tcltk.js, tcltk.wasm)
 * @returns {promise: Promise<void>}
 */
function configureTclTkModule(rootElement, loadPath) {
  // TODO is the following still relevant?
  // Re-create helpers now that we have the getMemory closure.
  // (We return getMemory so createBridge can be wired to the same closure.)


  const readyPromise = new Promise((resolve, reject) => {
    const module = globalThis.Module || {};

    // CSS selector string or the element itself — tcltk.wasm accepts "#id"
    // strings; we derive one if an element is passed directly.
    if (typeof rootElement === "string") {
      module.x11WasmRoot = rootElement;
    } else if (rootElement instanceof Element) {
      // Ensure the element has an id we can reference.
      if (!rootElement.id) rootElement.id = "_tkinter_wasm_root_" + Date.now();
      module.x11WasmRoot = "#" + rootElement.id;
    } else {
      module.x11WasmRoot = rootElement; // pass through whatever was given
    }

    module.x11WasmWindowManager = true;

    module.x11WasmServiceUserActivationEvents = function () {
      const svc = module._TkBrowserServiceUserActivationEvents;
      return typeof svc === "function" ? svc() : 0;
    };

    module.locateFile = function (path) {
      const name = String(path).split("/").pop()
      return loadPath + name;
    };

    // TKINTER-WASM: Capture the WebAssembly.Memory instance so we can
    // create Uint8Array views for string marshaling.  The prebuilt
    // tcltk.js does not export HEAPU8 on Module, so we intercept
    // instantiation to grab the memory export directly.
    //
    // We also replace the async __syscall_poll import with a synchronous
    // no-op.  The prebuilt tcltk.js uses Emscripten ASYNCIFY for poll(),
    // which returns a Promise.  When _TkBrowserEval is called synchronously
    // from Python/Pyodide, the asyncify unwind triggers a RuntimeError
    // ("unreachable" / ASYNCIFY_STACK_SIZE too small).  Since we never need
    // real file-descriptor polling in the browser, returning 0 (no events
    // ready) is safe and avoids the asyncify path entirely.
    module.instantiateWasm = function (info, receiveInstance) {
      const pollStub = function (_fds, _nfds, _timeout) { return 0; };
      if (info.env) info.env.__syscall_poll = pollStub;
      if (info.wasi_snapshot_preview1 && info.wasi_snapshot_preview1 !== info.env) {
        info.wasi_snapshot_preview1.__syscall_poll = pollStub;
      }

      const wasmUrl = module.locateFile("tcltk.wasm");
      WebAssembly.instantiateStreaming(fetch(wasmUrl), info)
        .then(function (result) {
          const instance = result.instance || result;
          if (instance.exports && instance.exports.memory) {
            module._tkinter_wasm_wasmMemory = instance.exports.memory;
          } else {
            throw new Error("Unable to get wasm memory")
          }
          receiveInstance(instance);
        })
        .catch(function (err) {
          console.error("[tkinter-wasm/configureTclTkModule]", "tcltk.wasm instantiation failed:", err);
          reject(err);
        });
      return {};
    };

    // TKINTER-WASM: Provide at least one script so that main()'s
    // BrowserRunArgumentScripts() sets ranArgumentScript=1.  When the array
    // is empty (ranArgumentScript==0), main() falls through to the built-in
    // demoScript which creates a smoke-test window.
    module.tkBrowserEvalScripts = [HIDE_ROOT_WINDOW_TCL_SCRIPT];
    module.arguments = [];
    module.print    = function (text) { console.log("[tkinter-wasm/tcltk.wasm/print]",  text); };
    module.printErr = function (text) { console.error("[tkinter-wasm/tcltk.wasm/printErr]", text); };

    const existingPostRun = module.postRun;
    const postRunList = Array.isArray(existingPostRun)
      ? [...existingPostRun]
      : existingPostRun ? [existingPostRun] : [];

    postRunList.push(function onTclTkReady() {
      try {
        bootstrapTclNamespace();
        installWindowTitlebarClampPatch();
      } catch (err) {
        console.error("[tkinter-wasm/onTclTkReady]", "_tkinter_wasm bootstrap failed:", err);
        reject(err);
        return;
      }

      // TKINTER-WASM: publish the bridge only after Tcl is fully live.
      globalThis._tkinter_wasm = createBridge();

      resolve();
    });

    module.postRun = postRunList;
    globalThis.Module = module;
  });

  return readyPromise;
}

/** Bootstrap the ::_tkinter_wasm namespace in Tcl.  Called once after
 *  tcltk.wasm postRun. */
function bootstrapTclNamespace() {
  tclEval(BOOTSTRAP_TCL_NAMESPACE_TCL_SCRIPT);
}

/**
 * Monkey-patch X11WasmDOMBackend.prototype.syncWindowManagerFrame so that
 * every new top-level window is clamped to y >= TITLE_HEIGHT on its very
 * first sync.
 *
 * Background: the x11.wasm window manager renders a 28 px titlebar *above*
 * the client area by positioning the frame element at DOM top = (window_y –
 * TITLE_HEIGHT).  When Tk places a window at the default y=0, the titlebar
 * ends up at –28 px — clipped by the container and invisible.  The window
 * manager already enforces y >= TITLE_HEIGHT when restoring a minimised
 * window (restoreWindowManagerFrame in manager-states.js), but that path is
 * never taken on initial creation.
 *
 * The fix wraps syncWindowManagerFrame.  When it detects a first-sync
 * (frame._tkinter_wasm_frameSynced is not yet set — frame.lastGeometry cannot
 * be used because syncWindowManagerStateGeometry, called just before
 * syncWindowManagerFrame in syncWindowManager, already sets it) and the window
 * is at y < TITLE_HEIGHT, it calls configureWindowManager to move the window
 * at the X11 level and returns immediately.  configureWindowManager
 * round-trips through the Tcl/Tk geometry machinery, which triggers a fresh
 * applyGeometry → syncWindowManagerFrame call with the corrected coordinates,
 * at which point _tkinter_wasm_frameSynced is still unset but resource.y is
 * already clamped, so the normal render path runs and the flag is set.
 *
 * No explicit guard for zoomed/fullscreen windows is required: when those
 * states are set on initial map, syncWindowManagerStateGeometry has already
 * moved resource.y to >= TITLE_HEIGHT before our wrapper runs, so
 * safeY === resource.y and the configureWindowManager branch is never taken.
 *
 * Called once from onTclTkReady, after all x11.wasm dom modules have run but
 * before any Tk windows are created.
 */
function installWindowTitlebarClampPatch() {
  const privateApi = globalThis["X11WasmDOMPrivate"];
  if (!privateApi) {
    console.warn("[tkinter-wasm/installWindowTitlebarClampPatch]",
      "X11WasmDOMPrivate not found — titlebar clamp patch not installed");
    return;
  }

  const proto = privateApi.X11WasmDOMBackend?.prototype;
  if (!proto || typeof proto.syncWindowManagerFrame !== "function") {
    console.warn("[tkinter-wasm/installWindowTitlebarClampPatch]",
      "syncWindowManagerFrame not found on prototype — titlebar clamp patch not installed");
    return;
  }

  // TITLE_HEIGHT must match the constant in manager.js / manager-states.js.
  // Both files define it as 28; it is the height of the titlebar decoration.
  const TITLE_HEIGHT = 28;
  const { CW_X, CW_Y } = privateApi;

  const _original = proto.syncWindowManagerFrame;

  proto.syncWindowManagerFrame = function _tkinter_wasm_syncWindowManagerFrame(
    resource, frame, metadata
  ) {
    // _tkinter_wasm_frameSynced is our own flag, set below after the first
    // call completes.  syncWindowManagerStateGeometry() (called just before
    // us in syncWindowManager) sets frame.lastGeometry, so that field is
    // already truthy on the very first entry — it cannot be used as a
    // first-sync guard.
    //
    // No explicit zoomed/fullscreen guard is needed: when a window is already
    // zoomed or fullscreen on first map, syncWindowManagerStateGeometry has
    // already repositioned it to y >= TITLE_HEIGHT, so safeY === resource.y
    // and the inner branch is never taken regardless.
    if (!frame._tkinter_wasm_frameSynced) {
      const safeY = Math.max(TITLE_HEIGHT, resource.y);
      if (safeY !== resource.y) {
        // Move the window at the X11/Tcl level.  configureWindowManager
        // round-trips through the Tk geometry machinery, which fires another
        // applyGeometry → syncWindowManager cycle with the corrected y.
        // We return early; that second cycle will reach the call below and
        // set _tkinter_wasm_frameSynced.
        this.configureWindowManager(
          resource.id, resource.x, safeY,
          resource.width, resource.height,
          CW_X | CW_Y
        );
        return;
      }
    }
    frame._tkinter_wasm_frameSynced = true;
    return _original.call(this, resource, frame, metadata);
  };
}


async function resetEnvironment(pyodide, bridge, executionId) {
  pyodide.runPython(UNIMPORT_TKINTER_MODULES_PYTHON_SCRIPT);

  // TKINTER-WASM: Clear all Python callbacks, Tcl variable traces, and
  // pending after-timers BEFORE destroying toplevels.  Without this, variable
  // traces from the previous run fire when PY_VAR* variables are recreated
  // (the _varnum counter resets on module reimport), invoking callbacks that
  // reference destroyed widgets and producing "invalid command name" errors.
  bridge.reset();

  bridge.eval(DESTROY_TK_WINDOWS_TCL_SCRIPT);

}

async function initializeTclTkWasm(loadPath, rootElement) {
  const tclTkScriptUrl = loadPath + "tcltk.js";

  const tclTkModuleReadyPromise = configureTclTkModule(rootElement, loadPath);

  // tcltk.js must be loaded as a regular script (Emscripten uses document.write
  // fallbacks and global Module) 
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = tclTkScriptUrl;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Failed to load tcltk.js from " + tclTkScriptUrl));
    document.head.appendChild(script);
  });
  console.log("[tkinter-wasm/initializeTclTkWasm]", "tcltk.js loaded");
  
  await tclTkModuleReadyPromise

  console.log("[tkinter-wasm/initializeTclTkWasm]", "tcl/tk environment ready");
}


async function initializePyodide(loadPath) {
  const pyodideUrl = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.js"
  const wheelUrl   = loadPath + "tkinter_wasm-0.1.0-py3-none-any.whl"

  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = pyodideUrl;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Failed to load Pyodide from " + pyodideUrl));
    document.head.appendChild(script);
  });
  console.log("[tkinter-wasm/initializePyodide]", "Pyodide script loaded");

  const pyodide = await globalThis.loadPyodide();

  console.log("[tkinter-wasm/initializePyodide]", "Pyodide loaded");

  await pyodide.loadPackage(wheelUrl);

  console.log("[tkinter-wasm/initializePyodide]", "tkinter-wasm wheel loaded");

  console.log("[tkinter-wasm/initializePyodide]", "python environment ready");
  return pyodide;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the tkinter-wasm environment.
 *
 * @param {Element|string} rootElement
 *   The DOM element (or CSS selector string) that Tk windows will render into.
 *
 * @param {string} loadPath
 *   Base URL / path prefix for all build artifacts
 *   (tcltk.js, tcltk.wasm, and the tkinter-wasm wheel).
 *   E.g. "build/" or "https://example.com/static/tkinter-wasm/".
 *
 * @returns {Promise<{
 *   pyodide: object,
 *   tkinter_wasm: object,
 *   runPython: (code: string) => Promise<void>,
 *   runTclTk: (code: string) => Promise<void>,
 * }>}
 *   Resolves once both tcltk.wasm and Pyodide are fully ready.
 *   The returned object exposes:
 *     - `pyodide`       — the raw Pyodide instance
 *     - `tkinter_wasm`  — the _tkinter_wasm Tcl/Tk bridge
 *     - `runPython(code)` — convenience helper that runs a Python string,
 *                           managing module cache reset; `executionId` names
 *                           the Tk toplevel for this run
 *     - `runTclTk(code)`  — convenience helper that evaluates a Tcl/Tk script
 *                           directly in the Tcl interpreter via the bridge,
 *                           returning the result string
 */
export async function initialize(loadPath, rootElement) {

  installTextDecoderWorkaroundIdempotent();

  // Now wait for both postRun (tcltk ready) and Pyodide to finish.
  const [, pyodide] = await Promise.all([
    initializeTclTkWasm(loadPath, rootElement),
    initializePyodide(loadPath)
  ]);

  pyodide.runPython(
    REDIRECT_PYTHON_OUTPUT_PYTHON_SCRIPT +
    EXPOSE_BRIDGE_PYTHON_SCRIPT +
    CREATE_GET_LAST_ERROR_PYTHON_SCRIPT +
    CREATE_QUIT_MAIN_LOOP_PYTHON_SCRIPT
  )

  const quit_main_loop = pyodide.globals.get("_tkinter_wasm_quit_main_loop");
  const get_last_execution_error = pyodide.globals.get("_tkinter_wasm_get_last_execution_error");

  console.log("[tkinter-wasm/initialize]", "ready");

  // ---------------------------------------------------------------------------
  // runPython — convenience wrapper
  // ---------------------------------------------------------------------------
  async function runPython(executionId, code, writeOutputHandler, writeErrorHandler, executionErrorHandler) {
    const bridge = globalThis._tkinter_wasm

    await resetEnvironment(pyodide, bridge, executionId);

    bridge.executionId = executionId
    bridge.rootWindowPath = '._tkinter_wasm_tk_' + executionId
    bridge.writeOutputHandler = writeOutputHandler
    bridge.writeErrorHandler = writeErrorHandler
    bridge.executionErrorHandler = executionErrorHandler

    // See: https://github.com/pyodide/pyodide/issues/703
    const dict = pyodide.globals.get('dict');
    const globals = dict();
    
    try {
      await pyodide.runPythonAsync(
        code, {
          filename: "main.py",
          globals: globals,
          locals: globals
        }
      );
      console.log("[tkinter-wasm/runPython]", "pyodide.runPythonAsync completed");
    } catch (e) {
      if (e instanceof Error && e.name == "PythonError") {
        const executionError = get_last_execution_error()
        if (executionError != null) {
          executionErrorHandler(executionError)
        } else {
          throw e;          
        }
      } else {
          throw e;
      }
    } finally {
      // TODO memleak for now. figure a good place to release these:
      // globals.destroy();
      // dict.destroy();

      await resetEnvironment(pyodide, bridge, executionId);
    }
  }

  // ---------------------------------------------------------------------------
  // runTclTk — convenience wrapper for evaluating Tcl/Tk scripts directly
  // in the Tcl interpreter via the _tkinter_wasm bridge, bypassing Pyodide.
  // Useful for driving pure Tcl/Tk code in the browser.
  // ---------------------------------------------------------------------------
  async function runTclTk(code) {
    const bridge = globalThis._tkinter_wasm;
    if (!bridge) {
      throw new Error("[tkinter-wasm/runTclTk] Tcl/Tk environment not ready");
    }
    const result = bridge.eval(String(code));
    console.log("[tkinter-wasm/runTclTk]", "tcl/tk eval completed");
    return result;
  }

  // ---------------------------------------------------------------------------
  // stopPython — signal a running Python execution to exit its mainloop
  // ---------------------------------------------------------------------------
  function stopPython(executionId) {
    const bridge = globalThis._tkinter_wasm;
    if (bridge.executionId !== executionId) {
      console.log("[tkinter-wasm/stopPython]", executionId, "execution id mismatch — ignored");
      return;
    }

    quit_main_loop();
    
    console.log("[tkinter-wasm/stopPython]", executionId, "quit signal sent");
  }

  return { runPython, stopPython, runTclTk };
}
