export const SERVER_INSTRUCTIONS = [
  'Astrograph is a pre-built local code graph for this workspace. Use it directly for structural, architecture, dependency, impact, and flow questions.',
  'Prefer astrograph_context for "how does X work" tasks. Use astrograph_trace for "how does X reach Y", astrograph_search to find symbols, astrograph_callers and astrograph_callees for call flow, astrograph_impact before edits, and astrograph_node or astrograph_explore when source needs to be inspected.',
  'Treat code blocks returned by astrograph_context, astrograph_explore, astrograph_trace, and astrograph_node as already read. Do not re-grep or re-open the same source unless the coverage banner says the relevant file is pending or partial.',
  'Always check the final coverage banner. If it says partial: yes, tell the user what may be missing and use direct file reads only for explicitly pending files.',
  'If a tool reports that no .astrograph index exists, offer to run `astrograph init`; do not assume the server indexed automatically.',
].join('\n\n');
