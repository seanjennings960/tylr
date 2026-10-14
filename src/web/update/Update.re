open Sexplib.Std;
open Ppx_yojson_conv_lib.Yojson_conv.Primitives;
open Stds;
open Tylr_core;
open Model;

let catch_exns = ref(true);

[@deriving (show({with_path: false}), sexp, yojson)]
type t =
  | Warmup
  | SetFont(Font.t)
  | PerformAction(Edit.t)
  | Undo
  | Redo
  | Load(int)
  | SourceSnapshot(string)
  | SourceLanguage(string)
  | OpenSource
  | CloseSource
  | SourceCommand(string, bool)
  | SourceJump(int, int, bool)
  | SourceSelectAll
  | SourceEditInput(string, string)
  | SourceStartEdit
  | SourceApplyEdit(string, string)
  | SourceDiscardEdit
  | SourceRecoverEdit
  | SourceExportEdit;

let is_f_key = s => Re.Str.(string_match(regexp("^F[0-9][0-9]*$"), s, 0));

let handle_source_key = (k: Util.Key.t, source: Model.Source.t): list(t) => {
  let extend = k.shift == Down;
  let command = name => [SourceCommand(name, extend)];
  switch (k.key) {
  | U(_) => []
  | D("a") when k.ctrl == Down || k.meta == Down => [SourceSelectAll]
  | D("ArrowLeft") => command(k.alt == Down ? "prevSibling" : "prevToken")
  | D("ArrowRight") => command(k.alt == Down ? "nextSibling" : "nextToken")
  | D("ArrowUp") => command("parent")
  | D("ArrowDown") => command("firstChild")
  | D("Home") => [SourceJump(source.caret.row, 0, extend)]
  | D("End") => [SourceJump(source.caret.row, 1000000000, extend)]
  | D("Escape") => [SourceJump(source.caret.row, source.caret.col, false)]
  | _ => []
  };
};

let handle_hazel_key = (k: Util.Key.t, ~model: Model.t): list(t) => {
  // let zipper = model.zipper;
  // let restricted = Backpack.restricted(zipper.backpack);
  // let now = a => [PerformAction(a), UpdateDoubleTap(None)];
  // let now_save_u = u => [u, Save, UpdateDoubleTap(None)];
  // let now_save = a => now_save_u(PerformAction(a));
  let now = a => [PerformAction(a)];
  let now_save_u = u => [u];
  let now_save = a => now_save_u(PerformAction(a));
  // let print = str => str |> print_endline |> (_ => []);
  // let toggle = m => (m := ! m^) |> (_ => []);
  switch (k) {
  // | {key: U(key), _} =>
  //   switch (key) {
  //   | "Shift" => [] // NOTE: don't update double_tap here
  //   | "Alt" => [SetShowBackpackTargets(false)]
  //   | _ => [UpdateDoubleTap(None)]
  //   }
  // | {key: D(key), sys: _, shift: Down, meta: Up, ctrl: Up, alt: Up}
  //     when is_f_key(key) =>
  //   if (key == "F12") {
  //     print_endline("Catch exceptions: " ++ string_of_bool(! catch_exns^));
  //     catch_exns := ! catch_exns^;
  //     [];
  //   } else {
  //     let index =
  //       int_of_string(Base.String.chop_prefix_exn(~prefix="F", key)) - 1;
  //     print_endline("F key pressed: index = " ++ string_of_int(index));
  //     now_save_u(Load(index));
  //   }
  | {key: D(key), sys: _, shift, meta: Up, ctrl: Up, alt: Up} =>
    switch (shift, key) {
    | (Up, "ArrowLeft") => now(Move(Step(H(L))))
    | (Up, "ArrowRight") => now(Move(Step(H(R))))
    | (Up, "ArrowUp") => now(Move(Step(V(L))))
    | (Up, "ArrowDown") => now(Move(Step(V(R))))
    | (Up, "Home") => now(Move(Skip(H(L))))
    | (Up, "End") => now(Move(Skip(H(R))))
    | (Up, "Backspace") => now_save(Delete(L))
    | (Up, "Delete") => now_save(Delete(R))
    | (Up, "Escape") => now(Select(Un(L)))
    | (Up, "Tab") => now(Tab(R))
    // | (Up, "Tab") => now_save(Put_down) //TODO: if empty, move to next hole
    | (Down, "Tab") => now(Tab(L))
    | (Down, "ArrowLeft") => now(Select(Move(Step(H(L)))))
    | (Down, "ArrowRight") => now(Select(Move(Step(H(R)))))
    | (Down, "ArrowUp") => now(Select(Move(Step(V(L)))))
    | (Down, "ArrowDown") => now(Select(Move(Step(V(R)))))
    // | (_, "Shift") => update_double_tap(model)
    | (_, "Enter") =>
      //TODO(andrew): using funky char to avoid weird regexp issues with using \n
      now_save(Insert("\n"))
    | _ when String.length(key) == 1 =>
      /* TODO(andrew): length==1 is hack to prevent things
         like F5 which are now valid tokens and also weird
         unicode shit which is multichar i guess */
      now_save(Insert(key))
    | _ => []
    }
  | {key: D(key), sys: Mac, shift: Down, meta: Down, ctrl: Up, alt: Up} =>
    switch (key) {
    | "Z"
    | "z" => now_save_u(Redo)
    | "ArrowLeft" => now(Select(Move(Skip(H(L)))))
    | "ArrowRight" => now(Select(Move(Skip(H(R)))))
    | "ArrowUp" => now(Select(Move(Skip(V(L)))))
    | "ArrowDown" => now(Select(Move(Skip(V(R)))))
    | _ => []
    }
  | {key: D(key), sys: PC, shift: Down, meta: Up, ctrl: Down, alt: Up} =>
    switch (key) {
    | "Z"
    | "z" => now_save_u(Redo)
    | "ArrowLeft" => now(Select(Move(Skip(H(L)))))
    | "ArrowRight" => now(Select(Move(Skip(H(R)))))
    | "ArrowUp"
    | "Home" => now(Select(Move(Skip(V(L)))))
    | "ArrowDown"
    | "End" => now(Select(Move(Skip(V(R)))))
    | _ => []
    }
  | {key: D(key), sys: Mac, shift: Up, meta: Down, ctrl: Up, alt: Up} =>
    switch (key) {
    | "z" => now_save_u(Undo)
    // | "x" => now(Pick_up)
    | "a" => now(Move(Skip(V(L)))) @ now(Select(Move(Skip(V(R)))))
    // | _ when is_digit(key) => [SwitchEditor(int_of_string(key))]
    | "ArrowLeft" => now(Move(Skip(H(L))))
    | "ArrowRight" => now(Move(Skip(H(R))))
    | "ArrowUp" => now(Move(Skip(V(L))))
    | "ArrowDown" => now(Move(Skip(V(R))))
    | _ => []
    }
  | {key: D(key), sys: PC, shift: Up, meta: Up, ctrl: Down, alt: Up} =>
    switch (key) {
    | "z" => now_save_u(Undo)
    // | "x" => now(Pick_up)
    | "a" => now(Move(Skip(V(L)))) @ now(Select(Move(Skip(V(R)))))
    // | _ when is_digit(key) => [SwitchEditor(int_of_string(key))]
    | "ArrowLeft" => now(Move(Skip(H(L))))
    | "ArrowRight" => now(Move(Skip(H(R))))
    | "ArrowUp" => now(Move(Skip(V(L))))
    | "ArrowDown" => now(Move(Skip(V(R))))
    | _ => []
    }
  | {key: D(key), sys: Mac, shift: Up, meta: Up, ctrl: Down, alt: Up} =>
    switch (key) {
    | "a" => now(Move(Skip(H(L))))
    | "e" => now(Move(Skip(H(R))))
    | "s" =>
      print_endline(Store.serialize(model.zipper));
      [];
    | _ => []
    }
  // | {key: D(key), sys, shift: Up, meta: Up, ctrl: Up, alt: Down} =>
  //   switch (sys, key) {
  //   | (_, "ArrowLeft") when restricted =>
  //     now(MoveToBackpackTarget(Left(ByToken)))
  //   | (_, "ArrowRight") when restricted =>
  //     now(MoveToBackpackTarget(Right(ByToken)))
  //   | (Mac, "ArrowLeft") => now(Move(Local(Left(ByToken))))
  //   | (Mac, "ArrowRight") => now(Move(Local(Right(ByToken))))
  //   | (_, "Alt") => [SetShowBackpackTargets(true), UpdateDoubleTap(None)]
  //   | (_, "ArrowUp") => now(MoveToBackpackTarget(Up))
  //   | (_, "ArrowDown") => now(MoveToBackpackTarget(Down))
  //   | _ => []
  //   }
  | _ => []
  };
};

let handle_key_event = (k, ~model: Model.t) =>
  switch (model.source) {
  | None => handle_hazel_key(k, ~model)
  | Some(source) => handle_source_key(k, source)
  };

module Failure = {
  [@deriving (show({with_path: false}), sexp, yojson)]
  type t =
    | CantUndo
    | CantRedo
    | FailedToPerform
    | Exception(string);
};

module Result = {
  include Result;
  type t('success) = Result.t('success, Failure.t);
};

let apply =
    (model: Model.t, update: t, _: State.t, ~schedule_action as _)
    : Result.t(Model.t) => {
  // print_endline("apply");
  switch (update) {
  | SourceSnapshot(json) =>
    let source = Model.Source.decode(json);
    let source =
      source.status == "closed" || source.status == "idle"
        ? None : Some(source);
    Ok({...model, source});
  | SourceLanguage(source_language) => Ok({...model, source_language})
  | OpenSource =>
    Util.SourceBridge.open_file(model.source_language);
    Ok({...model, source_edit_inputs: []});
  | CloseSource =>
    Util.SourceBridge.close();
    Ok({...model, source: None, source_edit_inputs: []});
  | SourceCommand(name, extend) =>
    Util.SourceBridge.command(name, extend);
    Ok(model);
  | SourceJump(row, col, extend) =>
    Util.SourceBridge.jump(row, col, extend);
    Ok(model);
  | SourceSelectAll =>
    Util.SourceBridge.select_all();
    Ok(model);
  | SourceEditInput(id, input) =>
    Ok({
      ...model,
      source_edit_inputs: [(id, input), ...List.remove_assoc(id, model.source_edit_inputs)],
    });
  | SourceStartEdit =>
    Util.SourceBridge.start_edit();
    Ok({...model, source_edit_inputs: []});
  | SourceApplyEdit(id, input) =>
    Util.SourceBridge.apply_edit(id, input);
    Ok(model);
  | SourceDiscardEdit =>
    Util.SourceBridge.discard_edit();
    Ok({...model, source_edit_inputs: []});
  | SourceRecoverEdit =>
    Util.SourceBridge.recover_edit();
    Ok(model);
  | SourceExportEdit =>
    Util.SourceBridge.export_edit();
    Ok(model);
  | Warmup =>
    Tylr_core.Walker.warmup();
    Ok(model);
  | SetFont(font) => Ok({...model, font})
  | PerformAction(_) when Option.is_some(model.source) => Ok(model)
  | PerformAction(a) =>
    switch (Edit.perform(a, model.zipper)) {
    | None => Error(FailedToPerform)
    | Some(z) =>
      Ok({
        ...model,
        zipper: z,
        history: History.do_(a, model.zipper, model.history),
      })
    }
  // | FailedInput(reason) => Error(UnrecognizedInput(reason))
  | Undo =>
    switch (History.undo(model.zipper, model.history)) {
    | None => Error(CantUndo)
    | Some((zipper, history)) => Ok({...model, zipper, history})
    }
  | Redo =>
    switch (History.redo(model.zipper, model.history)) {
    | None => Error(CantRedo)
    | Some((zipper, history)) => Ok({...model, zipper, history})
    }
  | Load(n) =>
    if (Option.is_some(model.source)) {
      Util.SourceBridge.close();
    };
    Ok({
      ...model,
      source: None,
      source_edit_inputs: [],
      editor: n,
      zipper: Store.load_default_syntax(n),
      history: History.empty,
      hist: [],
    })
  };
};
