import { render } from "ink";
import React from "react";
import { App } from "./app.js";

// Bun workaround: ensure stdin is flowing for Ink to receive input
process.stdin.resume();

render(<App />, {
  fullScreen: true,
});
