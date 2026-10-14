/* A language-neutral view of a server-backed document. Coordinates are display
   cells; source offsets in the browser controller remain UTF-16 code units. */
open Ppx_yojson_conv_lib.Yojson_conv.Primitives;

[@deriving yojson]
type point = {row: int, col: int};

[@deriving yojson]
type segment = {
  text: string,
  start: int,
  selected: bool,
  active: bool,
  role: string,
};

[@deriving yojson]
type line = {segments: list(segment)};

[@deriving yojson]
type t = {
  uri: string,
  source: string,
  status: string,
  message: string,
  focus_label: string,
  selection_label: string,
  selected_text: string,
  lines: list(line),
  caret: point,
  anchor: point,
  has_selection: bool,
};

let decode = json => t_of_yojson(Yojson.Safe.from_string(json));
