/// <reference path="../src/binaryen.d.ts" />
import "../src/glue/js";
import { Type, Module, MemorySegment, BinaryOp } from "../src/binaryen";
import { Target } from "../src/compiler";
import { U64 } from "../src/util";

const mod = Module.create();

mod.setMemory(1, Module.MAX_MEMORY_WASM32, [
  MemorySegment.create(new Uint8Array(4), U64.fromI32(8)),
  MemorySegment.create(new Uint8Array(4), U64.fromI32(12))
], Target.WASM32, "memory");

const add = mod.addFunctionType("iii", Type.I32, [ Type.I32, Type.I32 ]);
mod.addFunction("add", add, [], mod.createReturn(
  mod.createBinary(BinaryOp.AddI32,
    mod.createGetLocal(0, Type.I32),
    mod.createGetLocal(1, Type.I32)
  )
));
mod.addExport("add", "add");

const lit = mod.addFunctionType("I", Type.I64, []);
mod.addFunction("lit", lit, [], mod.createReturn(
  mod.createI64(0, 0x80000000) // I64_MIN
));
mod.addExport("lit", "lit");

mod.addGlobal("42", Type.I32, false, mod.createI32(42));

const aSwitch = mod.addFunctionType("ii", Type.I32, [ Type.I32 ]);
const rl = mod.createRelooper();
const b0 = rl.addBlockWithSwitch(mod.createNop(), mod.createGetLocal(0, Type.I32));
let b1, b2, b3;
rl.addBranchForSwitch(b0, b2 = rl.addBlock(mod.createReturn(mod.createI32(1))), [1]); // indexed branch
rl.addBranchForSwitch(b0, b3 = rl.addBlock(mod.createReturn(mod.createI32(2))), [2]); // indexed branch
rl.addBranch(b0, b1 = rl.addBlock(mod.createDrop(mod.createI32(0)))); // default branch
rl.addBranch(b1, b2);

mod.addFunction("aSwitch", aSwitch, [ Type.I32 ], mod.createBlock(null, [
  rl.renderAndDispose(b0, 1),
  mod.createUnreachable()
]));
mod.addExport("aSwitch", "aSwitch");

// mod.optimize();
if (mod.validate())
  _BinaryenModulePrint(mod.ref);
_BinaryenModuleDispose(mod.ref);
