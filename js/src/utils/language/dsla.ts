import { DslOpcodes as op } from './dslmachine';
import {
	InstructionFactory,
	int,
	mode,
	getVariableParts,
	RestFnTo,
	DSLError,
	InstructionBoundWithData,
} from './dslaHelpers';
import { InitializeWindowBarrel } from '../windowBarrel';
import { isNullOrWhitespace } from '../stringUtils';
import _ from 'lodash';
import { getFunctionArgs } from '../functionUtils';
import { SMap } from '../utilTypes';

type asmEmitterInternal = (
	/**
	 * the parameters that were supplied
	 */
	...parameters: string[]
) => InstructionBoundWithData[];

type dsla = typeof DslaInstructionRegistration;
type dslaInstructions = {
	[p in keyof dsla]: asmEmitterInternal;
};

//#region Helpers

const enforce = (args: string[], callee: Function) => {
	if (args.length < callee.length) {
		const missingArgs = getFunctionArgs(callee).slice(args.length);
		throw new DSLError(`Too few parameters provided, missing ${missingArgs.join(', ')}`);
	}
	else if (args.length < callee.length) {
		throw new DSLError('Too many parameters provided');
	}
	else if (args.some(isNullOrWhitespace)) {
		// some invalid parameters
		const argNames = getFunctionArgs(callee);
		args.forEach((argValue, index) => {
			if (isNullOrWhitespace(argValue)) {
				throw new DSLError(`Expected value for ${argNames[index]}`);
			}
		});
	}
};

type get = (str: string) => InstructionBoundWithData;
type label = (str: string) => () => number;

function GetValue(variable: string, v: RestFnTo<string, () => number>, l: RestFnTo<string, () => number>): InstructionBoundWithData {
	const varParts = getVariableParts(variable);
	if (!varParts) {
		throw new DSLError(`Could not parse ${variable} to variable expression`);
	}

	const { variableOffset, constantOffset, name } = varParts;

	const [d] = v(name);

	if (constantOffset !== null) {
		// else this variable is a pointer, and add the constant as an offset
		return op.LoadWithConstantOffsetToBus(d, () => constantOffset);
	}
	else if (variableOffset !== null) {
		const [offset] = v(variableOffset);
		return op.LoadWithVariableOffsetToBus(d, offset);
	}
	else {
		// then we will use this variable directly
		return op.LoadValueAtAddressIntoBus(d);
	}

}

function SaveValue(dest: string, v: RestFnTo<string, () => number>, l: RestFnTo<string, () => number>): InstructionBoundWithData {
	const varParts = getVariableParts(dest);
	if (!varParts) {
		throw new DSLError(`Could not parse ${dest} to variable expression`);
	}

	const { variableOffset, constantOffset, name } = varParts;

	const [d] = v(name);

	if (constantOffset !== null) {
		// else this variable is a pointer, and add the constant as an offset
		return op.SaveFromBusWithConstantOffset(d, () => constantOffset);
	}
	else if (variableOffset !== null) {
		const [offset] = v(variableOffset);
		return op.SaveFromBusWithVariableOffset(d, offset);
	}
	else {
		// then we will use this variable directly
		return op.SaveValueInBusToLocation(d);
	}
}

function GetLabel(label: string, l: RestFnTo<string, () => number>): () => number {
	const [_l] = l(label);
	return _l;
}

//#endregion

// DSL-Assembly

export const DslaInstructionRegistration = {
	add: 'Add',
	addi: 'Add immediate',
	loadi: 'Load immediate',
	goto: 'Go to label',
	beq: 'Branch on equal',
	halt: 'Halt program',
	beqal: 'Branch on equal and make current available on bus',
	gotol: 'Jump and link',
	captureLink: 'Capture bus to a location',
	ret: 'Return to a specified location',

	alert: 'Print out a string',
};

// ------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------

const _instructions = (Load: get, Save: get, Label: label): dslaInstructions => ({
	add(_dest, _source1, _source2) {
		return [
			Load(_source1),
			op.AluPushFromBus(),
			Load(_source2),
			op.AluDoAdd(),
			op.AluHiToBus(),
			Save(_dest),
		];
	},

	addi(_dest, _source, _imm) {
		return [
			Load(_source),
			op.AluPushFromBus(),
			op.LoadImmmediateToBus(int(_imm)),
			op.AluDoAdd(),
			op.AluHiToBus(),
			Save(_dest),
		];
	},

	loadi(_dest, _imm) {
		return [
			op.LoadImmmediateToBus(int(_imm)),
			Save(_dest),
		];
	},

	beq(_source1, _source2, _label) {
		return [
			Load(_source1),
			op.AluPushFromBus(),
			Load(_source2),
			op.AluDoComparisonWithMode(mode(0)),
			op.BranchTo(Label(_label)),
		];
	},

	goto(_label) {
		return [
			op.LoadImmmediateToBus(Label(_label)),
			op.JumpWithBusValueRelative(),
		];
	},

	beqal(_source1, _source2, _label) {
		return [
			Load(_source1),
			op.AluPushFromBus(),
			Load(_source2),
			op.AluDoComparisonWithMode(mode(0)),
			op.BranchTo(Label(_label)),
			op.LinkIfBranched(),
		];
	},

	gotol(_label) {
		return [
			op.LoadImmmediateToBus(Label(_label)),
			op.JumpWithBusValueRelative(),
			op.GetCurrentPosition(),
		];
	},

	captureLink(_linkDestination) {
		return [
			Save(_linkDestination),
		];
	},

	ret(_sourceVar) {
		return [
			Load(_sourceVar),
			op.JumpWithBusValueRelative(),
		];
	},

	alert(_ptr) {
		return [
			Load(_ptr),
			op.Alert(),
		];
	},

	halt() {
		return [
			op.Halt(),
		];
	},
});

// ------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------

// returns emitted dsl
export const instructions: InstructionFactory = (variableGet, labelGet) => _.mapValues(
	_instructions(
		(s: string) => GetValue(s, variableGet, labelGet),
		(s: string) => SaveValue(s, variableGet, labelGet),
		(s: string) => GetLabel(s, labelGet)
	),
	(instructionFunc, instructionName) => (args: string[]) => {
		enforce(args, instructionFunc);
		return {
			opcodes: instructionFunc(...args),
			generatingInstruction: instructionName + ' ' + args.join(' '),
			instructionName,
		};
	}
);

export const instructionSignatures: SMap<string[]> = _.mapValues(
	(_instructions as any)() as SMap<Function>,
	fn => getFunctionArgs(fn)
);

InitializeWindowBarrel('DSLA', {
	instructions,
	enforce,
});