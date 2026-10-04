export function handle(request: unknown) {
  console.log(request);
  console.error("bad");
  debugger;
  try {
    risky();
  } catch {}
  try {
    riskyToo();
  } catch (error) {
  }
  alert("hi");
  prompt("name?");
}

function risky() {}
function riskyToo() {}
