# Cargo collector fixture

This dependency-free crate has three integration tests, a critical tag, a branchy
library function, and an uncalled function. `expected.json` records the line
sets from the source and LLVM line mapping. Runtime version and durations vary.
The fixture test validates the input schema and report engine after collection.
