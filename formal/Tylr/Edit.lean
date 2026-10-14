import Std

/-!
An editor calculus for a deliberately small Python expression subset.

This module specifies syntax and editing, not Python evaluation or typing.
Expression and operator holes are editor syntax, not executable Python.
The original Python parser, source rendering, transport, and Python port are
outside these theorems' trusted scope.
-/

namespace Tylr

inductive Op where
  | add | sub | mul
  deriving Repr, DecidableEq, BEq

inductive Expr where
  | hole
  | name (value : String)
  | nat (value : Nat)
  | binary (op : Option Op) (left right : Expr)
  | paren (body : Expr)
  deriving Repr, DecidableEq, BEq

def nameStart (c : Char) : Bool :=
  c == '_' || decide ('a' ≤ c ∧ c ≤ 'z') || decide ('A' ≤ c ∧ c ≤ 'Z')

def nameContinue (c : Char) : Bool :=
  nameStart c || decide ('0' ≤ c ∧ c ≤ '9')

def keywords : List String :=
  ["False", "None", "True", "and", "as", "assert", "async", "await", "break",
   "class", "continue", "def", "del", "elif", "else", "except", "finally",
   "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
   "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"]

def validName (name : String) : Bool :=
  match name.toList with
  | [] => false
  | c :: cs => nameStart c && cs.all nameContinue && !keywords.contains name

def Expr.WF : Expr → Prop
  | .hole => True
  | .name value => validName value = true
  | .nat _ => True
  | .binary _ left right => left.WF ∧ right.WF
  | .paren body => body.WF

inductive Direction where
  | left | right | body
  deriving Repr, DecidableEq, BEq

abbrev Path := List Direction

def lookup (root : Expr) (path : Path) : Option Expr :=
  match path, root with
  | [], _ => some root
  | .left :: tail, .binary _ left _ => lookup left tail
  | .right :: tail, .binary _ _ right => lookup right tail
  | .body :: tail, .paren body => lookup body tail
  | _, _ => none

def replaceAt (root : Expr) (path : Path) (replacement : Expr) : Option Expr :=
  match path, root with
  | [], _ => some replacement
  | .left :: tail, .binary op left right =>
      (replaceAt left tail replacement).map fun next => .binary op next right
  | .right :: tail, .binary op left right =>
      (replaceAt right tail replacement).map fun next => .binary op left next
  | .body :: tail, .paren body =>
      (replaceAt body tail replacement).map Expr.paren
  | _, _ => none

structure State where
  root : Expr
  cursor : Path
  deriving Repr, DecidableEq, BEq

def State.WF (s : State) : Prop :=
  s.root.WF ∧ ∃ focused, lookup s.root s.cursor = some focused

inductive Action where
  | eraseOperator
  | fillOperator (op : Op)
  | eraseExpression
  | fillName (value : String)
  | fillNat (value : Nat)
  deriving Repr, DecidableEq, BEq

def editLocal (expression : Expr) (action : Action) : Option Expr :=
  match action, expression with
  | .eraseOperator, .binary (some _) left right => some (.binary none left right)
  | .fillOperator op, .binary none left right => some (.binary (some op) left right)
  | .eraseExpression, _ => some .hole
  | .fillName value, .hole => if validName value then some (.name value) else none
  | .fillNat value, .hole => some (.nat value)
  | _, _ => none

def edit (state : State) (action : Action) : Option State := do
  let focused ← lookup state.root state.cursor
  let replacement ← editLocal focused action
  let root ← replaceAt state.root state.cursor replacement
  pure { root, cursor := state.cursor }

def select (state : State) (path : Path) : Option State := do
  let _ ← lookup state.root path
  pure { root := state.root, cursor := path }

/- Independent relational rules specify when local edits are allowed. -/
inductive LocalStep : Expr → Action → Expr → Prop where
  | eraseOperator : LocalStep (.binary (some op) left right) .eraseOperator
      (.binary none left right)
  | fillOperator : LocalStep (.binary none left right) (.fillOperator op)
      (.binary (some op) left right)
  | eraseExpression : LocalStep expression .eraseExpression .hole
  | fillName (valid : validName value = true) :
      LocalStep .hole (.fillName value) (.name value)
  | fillNat : LocalStep .hole (.fillNat value) (.nat value)

theorem localStep_exec (step : LocalStep before action after) :
    editLocal before action = some after := by
  cases step <;> simp_all [editLocal]

theorem localStep_preserves_wf (step : LocalStep before action after)
    (valid : before.WF) : after.WF := by
  cases step <;> simp_all [Expr.WF]

theorem editLocal_spec (before : Expr) (action : Action) (after : Expr) :
    editLocal before action = some after ↔ LocalStep before action after := by
  constructor
  · intro result
    cases action with
    | eraseOperator =>
        cases before <;> simp [editLocal] at result
        rename_i op left right
        cases op <;> simp [editLocal] at result
        cases result
        exact .eraseOperator
    | fillOperator op =>
        cases before <;> simp [editLocal] at result
        rename_i old left right
        cases old <;> simp [editLocal] at result
        cases result
        exact .fillOperator
    | eraseExpression =>
        simp [editLocal] at result
        cases result
        exact .eraseExpression
    | fillName value =>
        cases before <;> simp [editLocal] at result
        split at result
        · cases result
          exact .fillName (by assumption)
        · contradiction
    | fillNat value =>
        cases before <;> simp [editLocal] at result
        cases result
        exact .fillNat
  · exact localStep_exec

theorem lookup_wf {root : Expr} {path : Path} {focused : Expr}
    (valid : root.WF) (found : lookup root path = some focused) : focused.WF := by
  induction path generalizing root with
  | nil => simp [lookup] at found; cases found; exact valid
  | cons dir tail ih =>
      cases root <;> cases dir <;> simp [lookup] at found
      · exact ih valid.1 found
      · exact ih valid.2 found
      · exact ih valid found

theorem replaceAt_preserves_wf {root replacement updated : Expr} {path : Path}
    (rootValid : root.WF) (replacementValid : replacement.WF)
    (result : replaceAt root path replacement = some updated) : updated.WF := by
  induction path generalizing root updated with
  | nil => simp [replaceAt] at result; exact result ▸ replacementValid
  | cons dir tail ih =>
      cases root <;> cases dir <;> simp [replaceAt] at result
      · obtain ⟨next, changed, rfl⟩ := result
        exact ⟨ih rootValid.1 changed, rootValid.2⟩
      · obtain ⟨next, changed, rfl⟩ := result
        exact ⟨rootValid.1, ih rootValid.2 changed⟩
      · obtain ⟨next, changed, rfl⟩ := result
        exact ih rootValid changed

theorem lookup_replaceAt {root replacement updated : Expr} {path : Path}
    (result : replaceAt root path replacement = some updated) :
    lookup updated path = some replacement := by
  induction path generalizing root updated with
  | nil => simp [replaceAt] at result; subst updated; rfl
  | cons dir tail ih =>
      cases root <;> cases dir <;> simp [replaceAt] at result
      all_goals obtain ⟨next, changed, rfl⟩ := result
      all_goals exact ih changed

theorem replaceAt_exists {root focused replacement : Expr} {path : Path}
    (found : lookup root path = some focused) :
    ∃ updated, replaceAt root path replacement = some updated := by
  induction path generalizing root with
  | nil => exact ⟨replacement, rfl⟩
  | cons dir tail ih =>
      cases root <;> cases dir <;> simp [lookup] at found
      all_goals obtain ⟨next, changed⟩ := ih found
      all_goals simp [replaceAt, changed]

theorem replaceAt_original {root focused : Expr} {path : Path}
    (found : lookup root path = some focused) :
    replaceAt root path focused = some root := by
  induction path generalizing root with
  | nil => simp [lookup] at found; subst focused; rfl
  | cons dir tail ih =>
      cases root <;> cases dir <;> simp [lookup] at found
      all_goals simp [replaceAt, ih found]

theorem replaceAt_overwrite {root first middle second : Expr} {path : Path}
    (changed : replaceAt root path first = some middle) :
    replaceAt middle path second = replaceAt root path second := by
  induction path generalizing root middle with
  | nil => simp [replaceAt] at changed; subst middle; rfl
  | cons dir tail ih =>
      cases root <;> cases dir <;> simp [replaceAt] at changed
      all_goals obtain ⟨next, changed, rfl⟩ := changed
      all_goals simp [replaceAt, ih changed]

theorem edit_preserves_wf {before after : State} {action : Action}
    (valid : before.WF) (result : edit before action = some after) : after.WF := by
  simp [edit, Option.bind_eq_some] at result
  obtain ⟨focused, found, replacement, localResult, root, replaced, rfl⟩ := result
  exact ⟨replaceAt_preserves_wf valid.1
      (localStep_preserves_wf ((editLocal_spec _ _ _).mp localResult) (lookup_wf valid.1 found))
      replaced,
    ⟨replacement, lookup_replaceAt replaced⟩⟩

theorem edit_preserves_cursor {before after : State} {action : Action}
    (result : edit before action = some after) : after.cursor = before.cursor := by
  simp [edit, Option.bind_eq_some] at result
  obtain ⟨_, _, _, _, _, _, rfl⟩ := result
  rfl

theorem select_preserves_wf {before after : State} {path : Path}
    (valid : before.WF) (result : select before path = some after) : after.WF := by
  simp [select, Option.bind_eq_some] at result
  obtain ⟨focused, found, rfl⟩ := result
  exact ⟨valid.1, focused, found⟩

theorem select_preserves_root {before after : State} {path : Path}
    (result : select before path = some after) : after.root = before.root := by
  simp [select, Option.bind_eq_some] at result
  obtain ⟨_, _, rfl⟩ := result
  rfl

/- This theorem restores the complete tree, including all context above and
   beside the focused operator, at any valid cursor path. -/
theorem erase_fill_operator_roundtrip {state : State} {op : Op} {left right : Expr}
    (found : lookup state.root state.cursor = some (.binary (some op) left right)) :
    ∃ erased, edit state .eraseOperator = some erased ∧
      lookup erased.root erased.cursor = some (.binary none left right) ∧
      edit erased (.fillOperator op) = some state := by
  obtain ⟨root, replaced⟩ :=
    replaceAt_exists (replacement := .binary none left right) found
  let erased : State := ⟨root, state.cursor⟩
  have atHole : lookup root state.cursor = some (.binary none left right) :=
    lookup_replaceAt replaced
  have restored : replaceAt root state.cursor (.binary (some op) left right) =
      some state.root := by
    rw [replaceAt_overwrite replaced, replaceAt_original found]
  refine ⟨erased, ?_, atHole, ?_⟩
  · simp [edit, editLocal, found, replaced, erased]
  · simp [edit, editLocal, atHole, restored, erased]

/- A hole-free completion exists for every valid editor expression. This is
   syntactic completion only; it claims neither execution nor type safety. -/
def complete : Expr → Expr
  | .hole => .nat 0
  | .name value => .name value
  | .nat value => .nat value
  | .binary op left right => .binary (some (op.getD .add)) (complete left) (complete right)
  | .paren body => .paren (complete body)

def Expr.Complete : Expr → Prop
  | .hole => False
  | .name _ => True
  | .nat _ => True
  | .binary op left right => op.isSome = true ∧ left.Complete ∧ right.Complete
  | .paren body => body.Complete

theorem completion_is_complete (expression : Expr) : (complete expression).Complete := by
  induction expression <;> simp_all [complete, Expr.Complete]

theorem completion_preserves_wf {expression : Expr} (valid : expression.WF) :
    (complete expression).WF := by
  induction expression <;> simp_all [complete, Expr.WF]

theorem completion_fixes_complete {expression : Expr} (done : expression.Complete) :
    complete expression = expression := by
  induction expression <;> simp_all [complete, Expr.Complete]
  rename_i op left right ihLeft ihRight
  cases op <;> simp_all

end Tylr
