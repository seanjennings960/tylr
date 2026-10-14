import Tylr
import Lean

open Lean Elab Command

/- Reject proof placeholders, external proof assumptions, and native-decide
   shortcuts by inspecting the transitive axiom dependencies of every named
   theorem in this model. The three allowed entries are Lean's standard
   logical foundations, not domain-specific assumptions. -/
run_cmd do
  let declarations := #[
    ``Tylr.localStep_exec,
    ``Tylr.localStep_preserves_wf,
    ``Tylr.editLocal_spec,
    ``Tylr.lookup_wf,
    ``Tylr.replaceAt_preserves_wf,
    ``Tylr.lookup_replaceAt,
    ``Tylr.replaceAt_exists,
    ``Tylr.replaceAt_original,
    ``Tylr.replaceAt_overwrite,
    ``Tylr.edit_preserves_wf,
    ``Tylr.edit_preserves_cursor,
    ``Tylr.select_preserves_wf,
    ``Tylr.select_preserves_root,
    ``Tylr.erase_fill_operator_roundtrip,
    ``Tylr.completion_is_complete,
    ``Tylr.completion_preserves_wf,
    ``Tylr.completion_fixes_complete]
  let allowed := #[``propext, ``Quot.sound, ``Classical.choice]
  for declaration in declarations do
    let axioms ← collectAxioms declaration
    for dependency in axioms do
      unless allowed.contains dependency do
        throwError "{declaration} depends on disallowed axiom {dependency}"
    logInfo m!"audited {declaration}: {axioms}"
  logInfo m!"Audited {declarations.size} editor-calculus theorems."
