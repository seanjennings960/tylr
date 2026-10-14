open Tylr_core;

module State = State;
module Font = Font;
module History = History;
module Source = Source;

type hist = list((string, string));

type t = {
  editor: int,
  zipper: Zipper.t,
  history: History.t,
  font: Font.t,
  hist,
  source: option(Source.t),
  source_language: string,
  source_edit_inputs: list((string, string)),
};

let cutoff = (==);

let init = {
  editor: 0,
  zipper: Zipper.empty,
  history: History.empty,
  font: Font.init,
  hist: [],
  source: None,
  source_language: "python",
  source_edit_inputs: [],
};

let init_from_store = _ => {
  {...init, zipper: Store.load_syntax(0)};
};
