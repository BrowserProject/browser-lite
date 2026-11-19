// The compiled code of a large function stays small (docs/jit.md, run with BL_JIT=2, run.sh checks
// the module's size in the JIT's log). An obfuscated VM (Cloudflare's Turnstile) is one function of
// about 50 KB of bytecode whose instructions are mostly reads and writes of global variables,
// closure variables and elements; with their fast paths inline at every site its module was 30 to
// 40 times its bytecode and ran little faster than the interpreter, its code too large for the
// processor's instruction caches (#630). The fast paths of these instructions are functions of the
// module now, called from every site.
var cases = [];
for (var i = 0; i < 200; i++)
    cases.push("case " + i + ": s = (s ^ (g" + (i % 8) + " || (g" + (i % 8) + " = " + (i + 1) + "))) + c" + (i % 4)
        + " + table[s & 7] + names[keys[s & 3]]; table[pc & 7] = s & 255; done" + (i % 8) + " = s; break;");
var source = "var c0 = 1, c1 = 2, c2 = 3, c3 = 4;\n"
    + "return function vmDispatch(steps) {\n"
    + "  var s = 1, pc = 0;\n"
    + "  for (var q = 0; q < steps; q++) {\n"
    + "    pc = (pc * 31 + 7) % 200;\n"
    + "    switch (pc) {\n" + cases.join("\n") + "\n    }\n"
    + "    s = s & 1023;\n"
    + "  }\n"
    + "  return s;\n"
    + "};";
var table = [1, 2, 3, 4, 5, 6, 7, 8], names = { p0: 1, p1: 2, p2: 3, p3: 4 }, keys = ["p0", "p1", "p2", "p3"];
// Globals the VM's code creates by assignment, like an obfuscator's string cache
for (var k = 0; k < 8; k++) {
    globalThis["g" + k] = 0;
    globalThis["done" + k] = 0;
}
var vmDispatch = new Function(source)();
var result = 0;
for (var r = 0; r < 300; r++)
    result = vmDispatch(5000);
if (result !== vmDispatch(5000) || typeof result !== "number")
    throw new Error("unexpected result " + result);
print("OK jit-size " + result);
