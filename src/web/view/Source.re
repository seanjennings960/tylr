/* Server-backed source participates in the normal Tylr Code view. Keep text
   unchanged and reuse the editor's token and caret SVG geometry. */
open Virtual_dom.Vdom;
open Tylr_core;

let text_segment = (s: Model.Source.segment) =>
  Node.span(
    ~attrs=Attr.[
      classes(
        ["source-segment"]
        @ (s.selected ? ["source-selected"] : [])
        @ (s.active ? ["source-active"] : []),
      ),
      create("data-source-start", string_of_int(s.start)),
    ],
    [Node.text(s.text)],
  );

let decorate = (~font, row, s: Model.Source.segment) =>
  s.width == 0 || (s.role != "token" && !s.active)
    ? []
    : [
        Dec.Token.outline(Tip.(Conv, Conv), s.width)
        |> Util.Nodes.add_classes(
             ["source-tile"] @ (s.active ? ["source-tile-active"] : []),
           )
        |> Stds.Lists.single
        |> Dec.Box.mk(~font, ~loc={row, col: s.col}),
      ];

let caret = (~font, hand, p: Model.Source.point) => {
  let profile: Dec.Caret.Profile.t = {
    loc: {row: p.row, col: p.col},
    hand,
    shape: Dec.Caret.Shape.Straight,
  };
  Dec.Caret.mk(~font, profile);
};

let view = (~font, source: Model.Source.t) => {
  let lines =
    source.lines
    |> List.map((line: Model.Source.line) =>
         Node.div(
           ~attrs=[Attr.class_("source-line")],
           List.map(text_segment, line.segments),
         )
       );
  let tiles =
    source.lines
    |> List.mapi((row, line: Model.Source.line) =>
         List.concat_map(decorate(~font, row), line.segments)
       )
    |> List.concat;
  let carets =
    [caret(~font, Caret.Hand.Focus, source.caret)]
    @ (source.has_selection
         ? [caret(~font, Caret.Hand.Anchor, source.anchor)] : []);
  Node.div(
    ~attrs=Attr.[
      classes(["code", "source-code"]),
      id("under-the-rail"),
      create("data-source-status", source.status),
      create("aria-label", "Source navigation"),
    ],
    [Node.div(~attrs=[Attr.class_("source-text")], lines)] @ tiles @ carets,
  );
};
