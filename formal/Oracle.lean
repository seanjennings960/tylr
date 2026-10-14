import Tylr
import Lean

/-!
JSON-lines adapter for differential testing against the executable definitions
checked in Tylr.Edit. Encoding/decoding and this IO adapter are not proven.
Natural numbers use decimal JSON strings to avoid host number precision loss.
-/

open Lean Tylr

namespace Tylr.Oracle

def decodeOp (json : Json) : Except String Op := do
  match ← json.getStr? with
  | "+" => pure .add
  | "-" => pure .sub
  | "*" => pure .mul
  | _ => throw "operator must be +, -, or *"

def encodeOp : Op → Json
  | .add => .str "+"
  | .sub => .str "-"
  | .mul => .str "*"

def decodeNat (json : Json) : Except String Nat := do
  let value ← json.getStr?
  match value.toNat? with
  | some number => pure number
  | none => throw "natural number must be a nonempty ASCII decimal string"

partial def decodeExpr (json : Json) : Except String Expr := do
  let kind ← (← json.getObjVal? "kind").getStr?
  match kind with
  | "hole" => pure .hole
  | "name" =>
      let value ← (← json.getObjVal? "value").getStr?
      if validName value then pure (.name value) else throw "invalid identifier in state"
  | "nat" => return .nat (← decodeNat (← json.getObjVal? "value"))
  | "binary" =>
      let rawOp ← json.getObjVal? "op"
      let op ← if rawOp.isNull then pure none else some <$> decodeOp rawOp
      let left ← decodeExpr (← json.getObjVal? "left")
      let right ← decodeExpr (← json.getObjVal? "right")
      pure (.binary op left right)
  | "paren" => return .paren (← decodeExpr (← json.getObjVal? "body"))
  | _ => throw "unknown expression kind"

def encodeExpr : Expr → Json
  | .hole => Json.mkObj [("kind", .str "hole")]
  | .name value => Json.mkObj [("kind", .str "name"), ("value", .str value)]
  | .nat value => Json.mkObj [("kind", .str "nat"), ("value", .str (toString value))]
  | .binary op left right => Json.mkObj [
      ("kind", .str "binary"), ("op", op.map encodeOp |>.getD .null),
      ("left", encodeExpr left), ("right", encodeExpr right)]
  | .paren body => Json.mkObj [("kind", .str "paren"), ("body", encodeExpr body)]

def decodeDirection (json : Json) : Except String Direction := do
  match ← json.getStr? with
  | "left" => pure .left
  | "right" => pure .right
  | "body" => pure .body
  | _ => throw "unknown cursor direction"

def encodeDirection : Direction → Json
  | .left => .str "left"
  | .right => .str "right"
  | .body => .str "body"

def decodePath (json : Json) : Except String Path := do
  let values ← json.getArr?
  return (← values.mapM decodeDirection).toList

def decodeState (json : Json) : Except String State := do
  let root ← decodeExpr (← json.getObjVal? "root")
  let cursor ← decodePath (← json.getObjVal? "cursor")
  if (lookup root cursor).isSome then
    pure { root, cursor }
  else
    throw "state cursor does not point to an expression"

def encodeState (state : State) : Json :=
  Json.mkObj [("root", encodeExpr state.root),
    ("cursor", .arr (state.cursor.map encodeDirection).toArray)]

def decodeAction (json : Json) : Except String Action := do
  match ← (← json.getObjVal? "kind").getStr? with
  | "erase_operator" => pure .eraseOperator
  | "fill_operator" => return .fillOperator (← decodeOp (← json.getObjVal? "op"))
  | "erase_expression" => pure .eraseExpression
  | "fill_name" => return .fillName (← (← json.getObjVal? "value").getStr?)
  | "fill_nat" => return .fillNat (← decodeNat (← json.getObjVal? "value"))
  | _ => throw "unknown action kind"

def process (request : Json) : Except String Json := do
  let state ← decodeState (← request.getObjVal? "state")
  let action ← request.getObjVal? "action"
  let kind ← (← action.getObjVal? "kind").getStr?
  let result ← if kind == "select" then
      pure (select state (← decodePath (← action.getObjVal? "path")))
    else
      pure (edit state (← decodeAction action))
  pure (Json.mkObj [("accepted", .bool result.isSome),
    ("state", result.map encodeState |>.getD .null)])

end Tylr.Oracle

def main : IO Unit := do
  let stdin ← IO.getStdin
  let stdout ← IO.getStdout
  repeat
    let line ← stdin.getLine
    if line.isEmpty then break
    let response := match Json.parse line >>= Tylr.Oracle.process with
      | .ok value => value
      | .error message => Json.mkObj [("error", .str message)]
    stdout.putStrLn response.compress
    stdout.flush
