import { useState } from "react";
import { Greet } from "../wailsjs/go/main/App";
import { Logo } from "./Logo";

function App() {
  const [result, setResult] = useState("Please enter your name below 👇");
  const [name, setName] = useState("");

  return (
    <div id="App">
      <Logo />
      <div className="result">{result}</div>
      <input value={name} onChange={(e) => setName(e.target.value)} />
      <button onClick={() => Greet(name).then(setResult)}>Greet</button>
    </div>
  );
}

export default App;
