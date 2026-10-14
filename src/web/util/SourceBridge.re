/* Only this adapter knows about the browser controller. It contains no lexer,
   syntax classes, grammar, or language-specific navigation rules. */
open Js_of_ocaml;

let call = (name, args) => {
  let api = Js.Unsafe.get(Js.Unsafe.global, "TylrSource");
  let _ = Js.Unsafe.meth_call(api, name, args);
  ();
};

let str = s => Js.Unsafe.inject(Js.string(s));
let boolean = b => Js.Unsafe.inject(Js.bool(b));

let start = receive =>
  call("start", [|Js.Unsafe.inject(Js.wrap_callback(json => receive(Js.to_string(json))))|]);

let open_file = language => call("openFile", [|str(language)|]);
let close = () => call("close", [||]);
let command = (name, extend) => call("command", [|str(name), boolean(extend)|]);
let jump = (row, col, extend) =>
  call("jump", [|Js.Unsafe.inject(row), Js.Unsafe.inject(col), boolean(extend)|]);
let select_all = () => call("selectAll", [||]);
let start_edit = () => call("startEdit", [||]);
let apply_edit = (action, input) => call("applyEdit", [|str(action), str(input)|]);
let discard_edit = () => call("discardEdit", [||]);
let recover_edit = () => call("recoverEdit", [||]);
let export_edit = () => call("exportEdit", [||]);
