/*

 This is a custom parser specifically written for the AssemblyScript subset. It
 accepts some of the most common TypeScript-only patterns that it knows an
 appropriate error message for but, though it uses TypeScript's codes for
 diagnostics, doesn't ultimately aim at full compatibility.

*/

import { Program } from "./program";
import { Tokenizer, Token, Range } from "./tokenizer";
import { DiagnosticCode, DiagnosticEmitter } from "./diagnostics";
import { normalizePath, I64 } from "./util";
import {

  NodeKind,
  Source,

  // types
  TypeNode,

  // expressions
  AssertionKind,
  Expression,
  IdentifierExpression,
  StringLiteralExpression,

  // statements
  BlockStatement,
  BreakStatement,
  ClassDeclaration,
  ContinueStatement,
  DecoratorStatement,
  DoStatement,
  EnumDeclaration,
  EnumValueDeclaration,
  ExportImportStatement,
  ExportMember,
  ExportStatement,
  ExpressionStatement,
  ForStatement,
  FunctionDeclaration,
  IfStatement,
  ImportDeclaration,
  ImportStatement,
  MethodDeclaration,
  Modifier,
  ModifierKind,
  DeclarationStatement,
  Parameter,
  FieldDeclaration,
  ReturnStatement,
  Statement,
  SwitchCase,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  TypeParameter,
  VariableStatement,
  VariableDeclaration,
  WhileStatement,

  hasModifier

} from "./ast";

export class Parser extends DiagnosticEmitter {

  program: Program;
  backlog: string[] = new Array();
  seenlog: Set<string> = new Set();

  constructor() {
    super();
    this.program = new Program(this.diagnostics);
  }

  parseFile(text: string, path: string, isEntry: bool): void {
    const normalizedPath: string = normalizePath(path);
    for (let i: i32 = 0, k: i32 = this.program.sources.length; i < k; ++i)
      if (this.program.sources[i].normalizedPath == normalizedPath)
        throw Error("duplicate source");
    this.seenlog.add(normalizedPath);

    const source: Source = new Source(path, text, isEntry);
    this.program.sources.push(source);

    const tn: Tokenizer = new Tokenizer(source, this.program.diagnostics);
    source.tokenizer = tn;

    while (!tn.skip(Token.ENDOFFILE)) {

      let decorators: DecoratorStatement[] | null = null;

      while (tn.skip(Token.AT)) {
        const decorator: DecoratorStatement | null = this.parseDecorator(tn);
        if (!decorator)
          break;
        if (!decorators)
          decorators = new Array();
        (<DecoratorStatement[]>decorators).push(<DecoratorStatement>decorator);
      }

      let modifiers: Modifier[] | null = null;

      if (tn.skip(Token.EXPORT))
        modifiers = addModifier(Statement.createModifier(ModifierKind.EXPORT, tn.range()), modifiers);

      if (tn.skip(Token.DECLARE)) {
        modifiers = addModifier(Statement.createModifier(ModifierKind.DECLARE, tn.range()), modifiers);
        tn.peek(true);
        if (tn.nextTokenOnNewLine)
          this.error(DiagnosticCode.Line_break_not_permitted_here, tn.range(tn.pos)); // recoverable, compatibility
      }

      tn.mark();

      let statement: Statement | null = null;
      switch (tn.next()) {

        case Token.CONST:
          modifiers = addModifier(Statement.createModifier(ModifierKind.CONST, tn.range()), modifiers);

          if (tn.skip(Token.ENUM)) {
            statement = this.parseEnum(tn, modifiers ? <Modifier[]>modifiers : createModifiers());
            break;
          }
          // fall through

        case Token.VAR:
        case Token.LET:
          statement = this.parseVariable(tn, modifiers ? <Modifier[]>modifiers : createModifiers());
          break;

        case Token.ENUM:
          statement = this.parseEnum(tn, modifiers ? <Modifier[]>modifiers : createModifiers());
          break;

        case Token.FUNCTION:
          statement = this.parseFunction(tn, modifiers ? <Modifier[]>modifiers : createModifiers(), decorators);
          decorators = null;
          break;

        case Token.ABSTRACT:
          if (!tn.skip(Token.CLASS)) {
            this.error(DiagnosticCode._0_expected, tn.range(tn.pos), "class");
            break;
          }
          modifiers = addModifier(Statement.createModifier(ModifierKind.ABSTRACT, tn.range()), modifiers);
          // fall through

        case Token.CLASS:
          statement = this.parseClass(tn, modifiers ? <Modifier[]>modifiers : createModifiers(), decorators);
          decorators = null;
          break;

        case Token.IMPORT:
          if (hasModifier(ModifierKind.EXPORT, modifiers)) {
            statement = this.parseExportImport(tn, getModifier(ModifierKind.EXPORT, <Modifier[]>modifiers).range);
          } else
            statement = this.parseImport(tn);
          if (modifiers)
            reusableModifiers = modifiers;
          break;

        case Token.TYPE:
          // TODO

        default:
          if (hasModifier(ModifierKind.EXPORT, modifiers)) {
            tn.reset();
            statement = this.parseExport(tn, modifiers ? <Modifier[]>modifiers : createModifiers());
          } else {
            if (modifiers) {
              if (hasModifier(ModifierKind.DECLARE, modifiers))
                this.error(DiagnosticCode._0_modifier_cannot_be_used_here, getModifier(ModifierKind.DECLARE, <Modifier[]>modifiers).range, "declare"); // recoverable
              reusableModifiers = modifiers;
            }
            tn.reset();
            statement = this.parseStatement(tn, true);
          }
          break;
      }

      if (decorators)
        for (let i: i32 = 0, k: i32 = (<DecoratorStatement[]>decorators).length; i < k; ++i)
          this.error(DiagnosticCode.Decorators_are_not_valid_here, (<DecoratorStatement[]>decorators)[i].range);
      if (!statement)
        return;
      statement.parent = source;
      source.statements.push(statement);
    }
    reusableModifiers = null;
  }

  nextFile(): string | null {
    if (this.backlog.length) {
      const filename: string = this.backlog[0];
      for (let i: i32 = 0, k: i32 = this.backlog.length - 1; i < k; ++i)
        this.backlog[i] = this.backlog[i + 1];
      this.backlog.length--;
      return filename;
    }
    return null;
  }

  finish(): Program {
    if (this.backlog.length)
      throw new Error("backlog is not empty");
    this.backlog = [];
    this.seenlog.clear();
    return this.program;
  }

  parseType(tn: Tokenizer, acceptParenthesized: bool = true): TypeNode | null {
    // not TypeScript-compatible
    const token: Token = tn.next();
    const startPos: i32 = tn.tokenPos;

    // void
    if (token == Token.VOID)
      return TypeNode.create(Expression.createIdentifier("void", tn.range()), [], false, tn.range(startPos, tn.pos));

    let type: TypeNode;

    // ( ... )
    if (acceptParenthesized && token == Token.OPENPAREN) {
      const innerType: TypeNode | null = this.parseType(tn, false);
      if (!innerType)
        return null;
      if (!tn.skip(Token.CLOSEPAREN)) {
        this.error(DiagnosticCode._0_expected, tn.range(tn.pos), "}");
        return null;
      }
      type = innerType;
      type.range.start = startPos;
      type.range.end = tn.pos;

    // this
    } else if (token == Token.THIS) {
      type = TypeNode.create(Expression.createThis(tn.range()), [], false, tn.range(startPos, tn.pos));

    // true
    } else if (token == Token.TRUE || token == Token.FALSE) {
      type = TypeNode.create(Expression.createIdentifier("bool", tn.range()), [], false, tn.range(startPos, tn.pos));

    // string literal
    } else if (token == Token.STRINGLITERAL) {
      tn.readString();
      type = TypeNode.create(Expression.createIdentifier("string", tn.range()), [], false, tn.range(startPos, tn.pos));

    // Name
    } else if (token == Token.IDENTIFIER) {
      const identifier: IdentifierExpression = Expression.createIdentifier(tn.readIdentifier(), tn.range());
      const parameters: TypeNode[] = new Array();
      let nullable: bool = false;

      // Name<T>
      if (tn.skip(Token.LESSTHAN)) {
        do {
          const parameter: TypeNode | null = this.parseType(tn, true);
          if (!parameter)
            return null;
          parameters.push(<TypeNode>parameter);
        } while (tn.skip(Token.COMMA));
        if (!tn.skip(Token.GREATERTHAN)) {
          this.error(DiagnosticCode._0_expected, tn.range(tn.pos), ">");
          return null;
        }
      }
      // ... | null
      if (tn.skip(Token.BAR)) {
        if (tn.skip(Token.NULL)) {
          nullable = true;
        } else {
          this.error(DiagnosticCode._0_expected, tn.range(tn.pos), "null");
          return null;
        }
      }
      type = TypeNode.create(identifier, parameters, nullable, tn.range(startPos, tn.pos));

    } else {
      this.error(DiagnosticCode.Identifier_expected, tn.range());
      return null;
    }
    // ... [][]
    while (tn.skip(Token.OPENBRACKET)) {
      let bracketStart: i32 = tn.tokenPos;
      if (!tn.skip(Token.CLOSEBRACKET)) {
        this.error(DiagnosticCode._0_expected, tn.range(), "]");
        return null;
      }
      const bracketRange = tn.range(bracketStart, tn.pos);

      // ...[] | null
      let nullable: bool = false;
      if (tn.skip(Token.BAR)) {
        if (tn.skip(Token.NULL)) {
          nullable = true;
        } else {
          this.error(DiagnosticCode._0_expected, tn.range(), "null");
          return null;
        }
      }
      type = TypeNode.create(Expression.createIdentifier("Array", bracketRange), [ type ], nullable, tn.range(startPos, tn.pos));
      if (nullable)
        break;
    }

    return type;
  }

  // statements

  parseDecorator(tn: Tokenizer): DecoratorStatement | null {
    // at '@': Identifier ('.' Identifier)* '(' Arguments
    const startPos: i32 = tn.tokenPos;
    if (tn.skip(Token.IDENTIFIER)) {
      let name: string = tn.readIdentifier();
      let expression: Expression = Expression.createIdentifier(name, tn.range(startPos, tn.pos));
      while (tn.skip(Token.DOT)) {
        if (tn.skip(Token.IDENTIFIER)) {
          name = tn.readIdentifier();
          expression = Expression.createPropertyAccess(expression, Expression.createIdentifier(name, tn.range()), tn.range(startPos, tn.pos));
        } else {
          this.error(DiagnosticCode.Identifier_expected, tn.range());
          return null;
        }
      }
      if (tn.skip(Token.OPENPAREN)) {
        const args: Expression[] | null = this.parseArguments(tn);
        if (args)
          return Statement.createDecorator(expression, <Expression[]>args, tn.range(startPos, tn.pos));
      } else
        this.error(DiagnosticCode._0_expected, tn.range(), "(");
    } else
      this.error(DiagnosticCode.Identifier_expected, tn.range());
    return null;
  }

  parseVariable(tn: Tokenizer, modifiers: Modifier[]): VariableStatement | null {
    // at ('const' | 'let' | 'var'): VariableDeclaration (',' VariableDeclaration)* ';'?
    const startPos: i32 = modifiers.length ? modifiers[0].range.start : tn.tokenPos;
    const members: VariableDeclaration[] = new Array();
    const isDeclare = hasModifier(ModifierKind.DECLARE, modifiers);
    do {
      const member: VariableDeclaration | null = this.parseVariableDeclaration(tn, isDeclare);
      if (!member)
        return null;
      members.push(<VariableDeclaration>member);
    } while (tn.skip(Token.COMMA));

    const ret: VariableStatement = Statement.createVariable(modifiers, members, tn.range(startPos, tn.pos));
    tn.skip(Token.SEMICOLON);
    return ret;
  }

  parseVariableDeclaration(tn: Tokenizer, isDeclare: bool = false): VariableDeclaration | null {
    // Identifier (':' Type)? ('=' Expression)?
    if (!tn.skip(Token.IDENTIFIER)) {
      this.error(DiagnosticCode.Identifier_expected, tn.range());
      return null;
    }
    const identifier: IdentifierExpression = Expression.createIdentifier(tn.readIdentifier(), tn.range());

    let type: TypeNode | null = null;
    if (tn.skip(Token.COLON)) {
      type = this.parseType(tn);
    } else
      this.error(DiagnosticCode.Type_expected, tn.range(tn.pos)); // recoverable

    let initializer: Expression | null = null;
    if (tn.skip(Token.EQUALS)) {
      if (isDeclare)
        this.error(DiagnosticCode.Initializers_are_not_allowed_in_ambient_contexts, tn.range()); // recoverable
      initializer = this.parseExpression(tn);
      if (!initializer)
        return null;
    }
    return Statement.createVariableDeclaration(identifier, type, initializer, Range.join(identifier.range, tn.range()));
  }

  parseEnum(tn: Tokenizer, modifiers: Modifier[]): EnumDeclaration | null {
    // at 'enum': Identifier '{' (EnumValueDeclaration (',' EnumValueDeclaration )*)? '}' ';'?
    const startPos: i32 = modifiers.length ? modifiers[0].range.start : tn.tokenPos;
    if (tn.next() != Token.IDENTIFIER) {
      this.error(DiagnosticCode.Identifier_expected, tn.range());
      return null;
    }
    const identifier: IdentifierExpression = Expression.createIdentifier(tn.readIdentifier(), tn.range());
    if (tn.next() != Token.OPENBRACE) {
      this.error(DiagnosticCode._0_expected, tn.range(), "{");
      return null;
    }
    const members: EnumValueDeclaration[] = new Array();
    if (!tn.skip(Token.CLOSEBRACE)) {
      do {
        const member: EnumValueDeclaration | null = this.parseEnumValue(tn);
        if (!member)
          return null;
        members.push(<EnumValueDeclaration>member);
      } while (tn.skip(Token.COMMA));
      if (!tn.skip(Token.CLOSEBRACE)) {
        this.error(DiagnosticCode._0_expected, tn.range(), "}");
        return null;
      }
    }
    const ret: EnumDeclaration = Statement.createEnum(modifiers, identifier, members, tn.range(startPos, tn.pos));
    tn.skip(Token.SEMICOLON);
    return ret;
  }

  parseEnumValue(tn: Tokenizer): EnumValueDeclaration | null {
    // Identifier ('=' Expression)?
    if (!tn.skip(Token.IDENTIFIER)) {
      this.error(DiagnosticCode.Identifier_expected, tn.range());
      return null;
    }
    const identifier: IdentifierExpression = Expression.createIdentifier(tn.readIdentifier(), tn.range());
    let value: Expression | null = null;
    if (tn.skip(Token.EQUALS)) {
      value = this.parseExpression(tn, Precedence.COMMA + 1);
      if (!value)
        return null;
    }
    return Statement.createEnumValue(identifier, value, Range.join(identifier.range, tn.range()));
  }

  parseReturn(tn: Tokenizer): ReturnStatement | null {
    // at 'return': Expression | (';' | '}' | ...'\n')
    let expr: Expression | null = null;
    if (tn.peek(true) != Token.SEMICOLON && tn.nextToken != Token.CLOSEBRACE && !tn.nextTokenOnNewLine) {
      expr = this.parseExpression(tn);
      if (!expr)
        return null;
    }
    const ret: ReturnStatement = Statement.createReturn(expr, tn.range());
    tn.skip(Token.SEMICOLON);
    return ret;
  }

  parseTypeParameters(tn: Tokenizer): TypeParameter[] | null {
    // at '<': TypeParameter (',' TypeParameter)* '>'
    const typeParameters: TypeParameter[] = new Array();
    if (!tn.skip(Token.GREATERTHAN)) {
      do {
        const typeParameter: TypeParameter | null = this.parseTypeParameter(tn);
        if (!typeParameter)
          return null;
        typeParameters.push(<TypeParameter>typeParameter);
      } while (tn.skip(Token.COMMA));
      if (!tn.skip(Token.GREATERTHAN)) {
        this.error(DiagnosticCode._0_expected, tn.range(), ">");
        return null;
      }
    } else
      this.error(DiagnosticCode.Type_parameter_list_cannot_be_empty, tn.range()); // recoverable
    return typeParameters;
  }

  parseTypeParameter(tn: Tokenizer): TypeParameter | null {
    // Identifier ('extends' Type)?
    if (tn.next() == Token.IDENTIFIER) {
      const identifier: IdentifierExpression = Expression.createIdentifier(tn.readIdentifier(), tn.range());
      let extendsName: TypeNode | null = null;
      if (tn.skip(Token.EXTENDS)) {
        extendsName = this.parseType(tn);
        if (!extendsName)
          return null;
      }
      return Statement.createTypeParameter(identifier, extendsName, Range.join(identifier.range, tn.range()));
    } else
      this.error(DiagnosticCode.Identifier_expected, tn.range());
    return null;
  }

  parseParameters(tn: Tokenizer): Parameter[] | null {
    // at '(': (Parameter (',' Parameter)*)? ')'
    const parameters: Parameter[] = new Array();
    if (tn.peek() != Token.CLOSEPAREN) {
      do {
        const param: Parameter | null = this.parseParameter(tn);
        if (!param)
          return null;
        parameters.push(<Parameter>param);
      } while (tn.skip(Token.COMMA));
    }
    if (tn.skip(Token.CLOSEPAREN))
      return parameters;
    else
      this.error(DiagnosticCode._0_expected, tn.range(), ")");
    return null;
  }

  parseParameter(tn: Tokenizer): Parameter | null {
    // '...'? Identifier (':' Type)? ('=' Expression)?
    let multiple: bool = false;
    let startRange: Range | null = null;
    if (tn.skip(Token.DOT_DOT_DOT)) {
      multiple = true;
      startRange = tn.range();
    }
    if (tn.skip(Token.IDENTIFIER)) {
      if (!multiple)
        startRange = tn.range();
      const identifier: IdentifierExpression = Expression.createIdentifier(tn.readIdentifier(), tn.range());
      let type: TypeNode | null = null;
      if (tn.skip(Token.COLON)) {
        type = this.parseType(tn);
        if (!type)
          return null;
      }
      let initializer: Expression | null = null;
      if (tn.skip(Token.EQUALS)) {
        initializer = this.parseExpression(tn);
        if (!initializer)
          return null;
      }
      return Statement.createParameter(identifier, type, initializer, multiple, Range.join(<Range>startRange, tn.range()));
    } else
      this.error(DiagnosticCode.Identifier_expected, tn.range());
    return null;
  }

  parseFunction(tn: Tokenizer, modifiers: Modifier[], decorators: DecoratorStatement[] | null): FunctionDeclaration | null {
    // at 'function': Identifier ('<' TypeParameters)? '(' Parameters (':' Type)? '{' Statement* '}' ';'?
    const startPos: i32 = decorators && (<DecoratorStatement[]>decorators).length
      ? (<DecoratorStatement[]>decorators)[0].range.start
      : modifiers.length
      ? modifiers[0].range.start
      : tn.tokenPos;

    if (!tn.skip(Token.IDENTIFIER)) {
      this.error(DiagnosticCode.Identifier_expected, tn.range(tn.pos));
      return null;
    }
    const identifier: IdentifierExpression = Expression.createIdentifier(tn.readIdentifier(), tn.range());
    let typeParameters: TypeParameter[] | null = null;
    if (tn.skip(Token.LESSTHAN)) {
      typeParameters = this.parseTypeParameters(tn);
      if (!typeParameters)
        return null;
    } else
      typeParameters = [];
    if (!tn.skip(Token.OPENPAREN)) {
      this.error(DiagnosticCode._0_expected, tn.range(tn.pos), "(");
      return null;
    }
    const parameters: Parameter[] | null = this.parseParameters(tn);
    if (!parameters)
      return null;
    let returnType: TypeNode | null = null;
    if (tn.skip(Token.COLON)) {
      returnType = this.parseType(tn);
      if (!returnType)
        return null;
    } else
      this.error(DiagnosticCode.Type_expected, tn.range(tn.pos)); // recoverable
    const isDeclare: bool = hasModifier(ModifierKind.DECLARE, modifiers);
    let statements: Statement[] | null = null;
    if (tn.skip(Token.OPENBRACE)) {
      statements = new Array();
      if (isDeclare)
        this.error(DiagnosticCode.An_implementation_cannot_be_declared_in_ambient_contexts, tn.range()); // recoverable
      while (!tn.skip(Token.CLOSEBRACE)) {
        const statement: Statement | null = this.parseStatement(tn);
        if (!statement)
          return null;
        statements.push(<Statement>statement);
      }
    } else if (!isDeclare)
      this.error(DiagnosticCode.Function_implementation_is_missing_or_not_immediately_following_the_declaration, tn.range(tn.pos));
    const ret: FunctionDeclaration = Statement.createFunction(modifiers, identifier, typeParameters, <Parameter[]>parameters, returnType, statements, decorators ? <DecoratorStatement[]>decorators : [], tn.range(startPos, tn.pos));
    tn.skip(Token.SEMICOLON);
    return ret;
  }

  parseClass(tn: Tokenizer, modifiers: Modifier[], decorators: DecoratorStatement[] | null): ClassDeclaration | null {
    // at 'class': Identifier ('<' TypeParameters)? ('extends' Type)? ('implements' Type (',' Type)*)? '{' ClassMember* '}'
    const startPos: i32 = decorators && (<DecoratorStatement[]>decorators).length
      ? (<DecoratorStatement[]>decorators)[0].range.start
      : modifiers.length
      ? modifiers[0].range.start
      : tn.tokenPos;

    if (tn.skip(Token.IDENTIFIER)) {
      const identifier: IdentifierExpression = Expression.createIdentifier(tn.readIdentifier(), tn.range());
      let typeParameters: TypeParameter[] | null;

      if (tn.skip(Token.LESSTHAN)) {
        typeParameters = this.parseTypeParameters(tn);
        if (!typeParameters)
          return null;
      } else
        typeParameters = [];

      let extendsType: TypeNode | null = null;
      if (tn.skip(Token.EXTENDS)) {
        extendsType = this.parseType(tn);
        if (!extendsType)
          return null;
      }

      let implementsTypes: TypeNode[] = new Array();
      if (tn.skip(Token.IMPLEMENTS)) {
        do {
          const type: TypeNode | null = this.parseType(tn);
          if (!type)
            return null;
          implementsTypes.push(<TypeNode>type);
        } while (tn.skip(Token.COMMA));
      }

      if (tn.skip(Token.OPENBRACE)) {
        const members: DeclarationStatement[] = new Array();
        if (!tn.skip(Token.CLOSEBRACE)) {
          const isDeclare = hasModifier(ModifierKind.DECLARE, modifiers);
          do {
            const member: DeclarationStatement | null = this.parseClassMember(tn, isDeclare);
            if (!member)
              return null;
            members.push(<DeclarationStatement>member);
          } while (!tn.skip(Token.CLOSEBRACE));
        }
        return Statement.createClass(modifiers, identifier, <TypeParameter[]>typeParameters, extendsType, implementsTypes, members, decorators ? <DecoratorStatement[]>decorators : [], tn.range(startPos, tn.pos));
      } else
        this.error(DiagnosticCode._0_expected, tn.range(), "{");
    } else
      this.error(DiagnosticCode.Identifier_expected, tn.range());
    return null;
  }

  parseClassMember(tn: Tokenizer, parentIsDeclare: bool): DeclarationStatement | null {
    // ('public' | 'private' | 'protected')? ('static' | 'abstract')? ('get' | 'set')? Identifier ...
    const startRange: Range = tn.range();

    let decorators: DecoratorStatement[] = new Array();

    while (tn.skip(Token.AT)) {
      const decorator: DecoratorStatement | null = this.parseDecorator(tn);
      if (!decorator)
        break;
      decorators.push(<DecoratorStatement>decorator);
    }

    let modifiers: Modifier[] | null = null;

    if (tn.skip(Token.PUBLIC))
      modifiers = addModifier(Statement.createModifier(ModifierKind.PUBLIC, tn.range()), modifiers);
    else if (tn.skip(Token.PRIVATE))
      modifiers = addModifier(Statement.createModifier(ModifierKind.PRIVATE, tn.range()), modifiers);
    else if (tn.skip(Token.PROTECTED))
      modifiers = addModifier(Statement.createModifier(ModifierKind.PROTECTED, tn.range()), modifiers);

    if (tn.skip(Token.STATIC))
      modifiers = addModifier(Statement.createModifier(ModifierKind.STATIC, tn.range()), modifiers);
    else if (tn.skip(Token.ABSTRACT))
      modifiers = addModifier(Statement.createModifier(ModifierKind.ABSTRACT, tn.range()), modifiers);

    if (tn.skip(Token.GET))
      modifiers = addModifier(Statement.createModifier(ModifierKind.GET, tn.range()), modifiers);
    else if (tn.skip(Token.SET))
      modifiers = addModifier(Statement.createModifier(ModifierKind.SET, tn.range()), modifiers);

    if (tn.skip(Token.IDENTIFIER)) {
      const identifier: IdentifierExpression = Expression.createIdentifier(tn.readIdentifier(), tn.range());
      let typeParameters: TypeParameter[] | null;
      if (tn.skip(Token.LESSTHAN)) {
        typeParameters = this.parseTypeParameters(tn);
        if (!typeParameters)
          return null;
      } else
        typeParameters = [];

      // method: '(' Parameters (':' Type)? '{' Statement* '}' ';'?
      if (tn.skip(Token.OPENPAREN)) {
        let parameters = this.parseParameters(tn);
        if (!parameters)
          return null;
        let returnType: TypeNode | null = null;
        if (tn.skip(Token.COLON)) {
          returnType = this.parseType(tn);
          if (!returnType)
            return null;
        } else
          this.error(DiagnosticCode.Type_expected, tn.range()); // recoverable
        let statements: Statement[] | null = null;
        if (tn.skip(Token.OPENBRACE)) {
          if (parentIsDeclare)
            this.error(DiagnosticCode.An_implementation_cannot_be_declared_in_ambient_contexts, tn.range()); // recoverable
          statements = new Array();
          while (!tn.skip(Token.CLOSEBRACE)) {
            const statement: Statement | null = this.parseStatement(tn);
            if (!statement)
              return null;
            statements.push(<Statement>statement);
          }
        } else {
          if (!parentIsDeclare)
            this.error(DiagnosticCode.Function_implementation_is_missing_or_not_immediately_following_the_declaration, tn.range()); // recoverable
        }

        const ret: MethodDeclaration = Statement.createMethod(modifiers ? modifiers : createModifiers(), identifier, <TypeParameter[]>typeParameters, <Parameter[]>parameters, returnType, statements, decorators, Range.join(startRange, tn.range()));
        tn.skip(Token.SEMICOLON);
        return ret;

      // field: (':' Type)? ('=' Expression)? ';'?
      } else {
        if (hasModifier(ModifierKind.ABSTRACT, modifiers))
          this.error(DiagnosticCode._0_modifier_cannot_be_used_here, getModifier(ModifierKind.ABSTRACT, <Modifier[]>modifiers).range, "abstract"); // recoverable
        if (hasModifier(ModifierKind.GET, modifiers))
          this.error(DiagnosticCode._0_modifier_cannot_be_used_here, getModifier(ModifierKind.GET, <Modifier[]>modifiers).range, "get"); // recoverable
        if (hasModifier(ModifierKind.SET, modifiers))
          this.error(DiagnosticCode._0_modifier_cannot_be_used_here,getModifier(ModifierKind.SET, <Modifier[]>modifiers).range, "set"); // recoverable
        let type: TypeNode | null = null;
        if (tn.skip(Token.COLON)) {
          type = this.parseType(tn);
          if (!type)
            return null;
        } else
          this.error(DiagnosticCode.Type_expected, tn.range()); // recoverable
        let initializer: Expression | null = null;
        if (tn.skip(Token.EQUALS)) {
          initializer = this.parseExpression(tn);
          if (!initializer)
            return null;
        }
        const ret: FieldDeclaration = Statement.createField(modifiers ? modifiers : createModifiers(), identifier, type, initializer, decorators, Range.join(startRange, tn.range()));
        tn.skip(Token.SEMICOLON);
        return ret;
      }
    } else
      this.error(DiagnosticCode.Identifier_expected, tn.range());
    return null;
  }

  parseExport(tn: Tokenizer, modifiers: Modifier[]): ExportStatement | null {
    // at 'export': '{' ExportMember (',' ExportMember)* }' ('from' StringLiteral)? ';'?
    const startRange: Range = modifiers.length ? modifiers[0].range : tn.range();
    if (tn.skip(Token.OPENBRACE)) {
      const members: ExportMember[] = new Array();
      if (!tn.skip(Token.CLOSEBRACE)) {
        do {
          const member: ExportMember | null = this.parseExportMember(tn);
          if (!member)
            return null;
          members.push(member);
        } while (tn.skip(Token.COMMA));
        if (!tn.skip(Token.CLOSEBRACE)) {
          this.error(DiagnosticCode._0_expected, tn.range(), "}");
          return null;
        }
      }
      let path: StringLiteralExpression | null = null;
      if (tn.skip(Token.FROM)) {
        if (tn.skip(Token.STRINGLITERAL))
          path = Expression.createStringLiteral(tn.readString(), tn.range());
        else {
          this.error(DiagnosticCode.String_literal_expected, tn.range());
          return null;
        }
      }
      const ret: ExportStatement = Statement.createExport(modifiers, members, path, Range.join(startRange, tn.range()));
      if (ret.normalizedPath && !this.seenlog.has(<string>ret.normalizedPath)) {
        this.backlog.push(<string>ret.normalizedPath);
        this.seenlog.add(<string>ret.normalizedPath);
      }
      tn.skip(Token.SEMICOLON);
      return ret;
    } else
      this.error(DiagnosticCode._0_expected, tn.range(), "{");
    return null;
  }

  parseExportMember(tn: Tokenizer): ExportMember | null {
    // Identifier ('as' Identifier)?
    if (tn.skip(Token.IDENTIFIER)) {
      const identifier: IdentifierExpression = Expression.createIdentifier(tn.readIdentifier(), tn.range());
      let asIdentifier: IdentifierExpression | null = null;
      if (tn.skip(Token.AS)) {
        if (tn.skip(Token.IDENTIFIER))
          asIdentifier = Expression.createIdentifier(tn.readIdentifier(), tn.range());
        else {
          this.error(DiagnosticCode.Identifier_expected, tn.range());
          return null;
        }
      }
      return Statement.createExportMember(identifier, asIdentifier, asIdentifier ? Range.join(identifier.range, asIdentifier.range) : identifier.range);
    } else
      this.error(DiagnosticCode.Identifier_expected, tn.range());
    return null;
  }

  parseImport(tn: Tokenizer): ImportStatement | null {
    // at 'import': '{' (ImportMember (',' ImportMember)*)? '}' 'from' StringLiteral ';'?
    const startRange: Range = tn.range();
    if (tn.skip(Token.OPENBRACE)) {
      const members: ImportDeclaration[] = new Array();
      if (!tn.skip(Token.CLOSEBRACE)) {
        do {
          const member: ImportDeclaration | null = this.parseImportDeclaration(tn);
          if (!member)
            return null;
          members.push(member);
        } while (tn.skip(Token.COMMA));
        if (!tn.skip(Token.CLOSEBRACE)) {
          this.error(DiagnosticCode._0_expected, tn.range(), "}");
          return null;
        }
      }
      if (tn.skip(Token.FROM)) {
        if (tn.skip(Token.STRINGLITERAL)) {
          const path: StringLiteralExpression = Expression.createStringLiteral(tn.readString(), tn.range());
          const ret: ImportStatement = Statement.createImport(members, path, Range.join(startRange, tn.range()));
          if (!this.seenlog.has(ret.normalizedPath)) {
            this.backlog.push(ret.normalizedPath);
            this.seenlog.add(ret.normalizedPath);
          }
          tn.skip(Token.SEMICOLON);
          return ret;
        } else
          this.error(DiagnosticCode.String_literal_expected, tn.range());
      } else
        this.error(DiagnosticCode._0_expected, tn.range(), "from");
    } else
      this.error(DiagnosticCode._0_expected, tn.range(), "{");
    return null;
  }

  parseImportDeclaration(tn: Tokenizer): ImportDeclaration | null {
    // Identifier ('as' Identifier)?
    if (tn.skip(Token.IDENTIFIER)) {
      const identifier: IdentifierExpression = Expression.createIdentifier(tn.readIdentifier(), tn.range());
      let asIdentifier: IdentifierExpression | null = null;
      if (tn.skip(Token.AS)) {
        if (tn.skip(Token.IDENTIFIER))
          asIdentifier = Expression.createIdentifier(tn.readIdentifier(), tn.range());
        else {
          this.error(DiagnosticCode.Identifier_expected, tn.range());
          return null;
        }
      }
      return Statement.createImportDeclaration(identifier, asIdentifier, asIdentifier ? Range.join(identifier.range, asIdentifier.range) : identifier.range);
    } else
      this.error(DiagnosticCode.Identifier_expected, tn.range());
    return null;
  }

  parseExportImport(tn: Tokenizer, startRange: Range): ExportImportStatement | null {
    // at 'export' 'import': Identifier ('=' Identifier)? ';'?
    if (tn.skip(Token.IDENTIFIER)) {
      const asIdentifier: IdentifierExpression = Expression.createIdentifier(tn.readIdentifier(), tn.range());
      if (tn.skip(Token.EQUALS)) {
        if (tn.skip(Token.IDENTIFIER)) {
          const identifier: IdentifierExpression = Expression.createIdentifier(tn.readIdentifier(), tn.range());
          const ret: ExportImportStatement = Statement.createExportImport(identifier, asIdentifier, Range.join(startRange, tn.range()));
          tn.skip(Token.SEMICOLON);
          return ret;
        } else
          this.error(DiagnosticCode.Identifier_expected, tn.range());
      } else
        this.error(DiagnosticCode._0_expected, tn.range(), "=");
    } else
      this.error(DiagnosticCode.Identifier_expected, tn.range());
    return null;
  }

  parseStatement(tn: Tokenizer, topLevel: bool = false): Statement | null {
    // at previous token
    tn.mark();
    const token: Token = tn.next();
    switch (token) {

      case Token.BREAK:
        return this.parseBreak(tn);

      case Token.CONST:
        return this.parseVariable(tn, [ Statement.createModifier(ModifierKind.CONST, tn.range()) ]);

      case Token.CONTINUE:
        return this.parseContinue(tn);

      case Token.DO:
        return this.parseDoStatement(tn);

      case Token.FOR:
        return this.parseForStatement(tn);

      case Token.IF:
        return this.parseIfStatement(tn);

      case Token.LET:
      case Token.VAR:
        return this.parseVariable(tn, []);

      case Token.OPENBRACE:
        return this.parseBlockStatement(tn, topLevel);

      case Token.RETURN:
        if (topLevel)
          this.error(DiagnosticCode.A_return_statement_can_only_be_used_within_a_function_body, tn.range()); // recoverable
        return this.parseReturn(tn);

      case Token.SEMICOLON:
        return Statement.createEmpty(tn.range(tn.tokenPos));

      case Token.SWITCH:
        return this.parseSwitchStatement(tn);

      case Token.THROW:
        return this.parseThrowStatement(tn);

      case Token.TRY:
        return this.parseTryStatement(tn);

      case Token.WHILE:
        return this.parseWhileStatement(tn);

      default:
        tn.reset();
        return this.parseExpressionStatement(tn);
    }
  }

  parseBlockStatement(tn: Tokenizer, topLevel: bool): BlockStatement | null {
    // at '{': Statement* '}' ';'?
    const startPos: i32 = tn.tokenPos;
    const statements: Statement[] = new Array();
    while (!tn.skip(Token.CLOSEBRACE)) {
      const statement: Statement | null = this.parseStatement(tn, topLevel);
      if (!statement)
        return null;
      statements.push(statement);
    }
    const ret: BlockStatement = Statement.createBlock(statements, tn.range(startPos, tn.pos));
    tn.skip(Token.SEMICOLON);
    return ret;
  }

  parseBreak(tn: Tokenizer): BreakStatement | null {
    // at 'break': Identifier? ';'?
    let identifier: IdentifierExpression | null = null;
    if (tn.peek(true) == Token.IDENTIFIER && !tn.nextTokenOnNewLine) {
      tn.next(true);
      identifier = Expression.createIdentifier(tn.readIdentifier(), tn.range());
    }
    const ret: ContinueStatement = Statement.createBreak(identifier, tn.range());
    tn.skip(Token.SEMICOLON);
    return ret;
  }

  parseContinue(tn: Tokenizer): ContinueStatement | null {
    // at 'continue': Identifier? ';'?
    let identifier: IdentifierExpression | null = null;
    if (tn.peek(true) == Token.IDENTIFIER && !tn.nextTokenOnNewLine) {
      tn.next(true);
      identifier = Expression.createIdentifier(tn.readIdentifier(), tn.range());
    }
    const ret: ContinueStatement = Statement.createContinue(identifier, tn.range());
    tn.skip(Token.SEMICOLON);
    return ret;
  }

  parseDoStatement(tn: Tokenizer): DoStatement | null {
    // at 'do': Statement 'while' '(' Expression ')' ';'?
    const startPos: i32 = tn.tokenPos;
    const statement: Statement | null = this.parseStatement(tn);
    if (!statement)
      return null;
    if (tn.skip(Token.WHILE)) {
      if (tn.skip(Token.OPENPAREN)) {
        const condition: Expression | null = this.parseExpression(tn);
        if (!condition)
          return null;
        if (tn.skip(Token.CLOSEPAREN)) {
          const ret: DoStatement = Statement.createDo(<Statement>statement, <Expression>condition, tn.range(startPos, tn.pos));
          tn.skip(Token.SEMICOLON);
          return ret;
        }
        this.error(DiagnosticCode._0_expected, tn.range(), ")");
      } else
        this.error(DiagnosticCode._0_expected, tn.range(), "(");
    } else
      this.error(DiagnosticCode._0_expected, tn.range(), "while");
    return null;
  }

  parseExpressionStatement(tn: Tokenizer): ExpressionStatement | null {
    // at previous token
    const expr: Expression | null = this.parseExpression(tn);
    if (!expr)
      return null;
    const ret: ExpressionStatement = Statement.createExpression(expr);
    tn.skip(Token.SEMICOLON);
    return ret;
  }

  parseForStatement(tn: Tokenizer): ForStatement | null {
    // at 'for': '(' Statement? Expression? ';' Expression? ')' Statement
    const startPos: i32 = tn.tokenPos;
    if (tn.skip(Token.OPENPAREN)) {
      const initializer: Statement | null = this.parseStatement(tn); // skips the semicolon (actually an expression)
      if (!initializer)
        return null;
      if (initializer.kind != NodeKind.EXPRESSION && initializer.kind != NodeKind.VARIABLE)
        this.error(DiagnosticCode.Expression_expected, initializer.range); // recoverable
      if (tn.token == Token.SEMICOLON) {
        const condition: Expression | null = this.parseExpression(tn);
        if (!condition)
          return null;
        if (tn.skip(Token.SEMICOLON)) {
          const incrementor: Expression | null = this.parseExpression(tn);
          if (!incrementor)
            return null;
          if (tn.skip(Token.CLOSEPAREN)) {
            const statement: Statement | null = this.parseStatement(tn);
            if (!statement)
              return null;
            return Statement.createFor(initializer, condition, incrementor, statement, tn.range(startPos, tn.pos));
          } else
            this.error(DiagnosticCode._0_expected, tn.range(), ")");
        } else
          this.error(DiagnosticCode._0_expected, tn.range(), ";");
      } else
        this.error(DiagnosticCode._0_expected, tn.range(), ";");
    } else
      this.error(DiagnosticCode._0_expected, tn.range(), "(");
    return null;
  }

  parseIfStatement(tn: Tokenizer): IfStatement | null {
    // at 'if': '(' Expression ')' Statement ('else' Statement)?
    const startRange: Range = tn.range();
    if (tn.skip(Token.OPENPAREN)) {
      const condition: Expression | null = this.parseExpression(tn);
      if (!condition)
        return null;
      if (tn.skip(Token.CLOSEPAREN)) {
        const statement: Statement | null = this.parseStatement(tn);
        if (!statement)
          return null;
        let elseStatement: Statement | null = null;
        if (tn.skip(Token.ELSE)) {
          elseStatement = this.parseStatement(tn);
          if (!elseStatement)
            return null;
        }
        return Statement.createIf(<Expression>condition, <Statement>statement, elseStatement, Range.join(startRange, tn.range()));
      }
      this.error(DiagnosticCode._0_expected, tn.range(), ")");
    } else
      this.error(DiagnosticCode._0_expected, tn.range(), "(");
    return null;
  }

  parseSwitchStatement(tn: Tokenizer): SwitchStatement | null {
    // at 'switch': '(' Expression ')' '{' SwitchCase* '}' ';'?
    const startPos: i32 = tn.tokenPos;
    if (tn.skip(Token.OPENPAREN)) {
      const condition: Expression | null = this.parseExpression(tn);
      if (!condition)
        return null;
      if (tn.skip(Token.CLOSEPAREN)) {
        if (tn.skip(Token.OPENBRACE)) {
          const cases: SwitchCase[] = [];
          while (!tn.skip(Token.CLOSEBRACE)) {
            const case_: SwitchCase | null = this.parseSwitchCase(tn);
            if (!case_)
              return null;
            cases.push(<SwitchCase>case_);
          }
          const ret: SwitchStatement = Statement.createSwitch(condition, cases, tn.range(startPos, tn.pos));
          tn.skip(Token.SEMICOLON);
          return ret;
        } else
          this.error(DiagnosticCode._0_expected, tn.range(), "{");
      } else
        this.error(DiagnosticCode._0_expected, tn.range(), ")");
    } else
      this.error(DiagnosticCode._0_expected, tn.range(), "(");
    return null;
  }

  parseSwitchCase(tn: Tokenizer): SwitchCase | null {
    const startPos: i32 = tn.tokenPos;

    // 'case' Expression ':' Statement*
    if (tn.skip(Token.CASE)) {
      const label: Expression | null = this.parseExpression(tn);
      if (!label)
        return null;
      if (tn.skip(Token.COLON)) {
        const statements: Statement[] = new Array();
        while (tn.peek() != Token.CASE && tn.nextToken != Token.DEFAULT && tn.nextToken != Token.CLOSEBRACE) {
          const statement: Statement | null = this.parseStatement(tn);
          if (!statement)
            return null;
          statements.push(<Statement>statement);
        }
        return Statement.createSwitchCase(<Expression>label, statements, tn.range(startPos, tn.pos));
      } else
        this.error(DiagnosticCode._0_expected, tn.range(), ":");

    // 'default' ':' Statement*
    } else if (tn.nextToken == Token.DEFAULT) {
      tn.next();
      if (tn.skip(Token.COLON)) {
        const statements: Statement[] = new Array();
        while (tn.peek() != Token.CASE && tn.nextToken != Token.DEFAULT && tn.nextToken != Token.CLOSEBRACE) {
          const statement: Statement | null = this.parseStatement(tn);
          if (!statement)
            return null;
          statements.push(<Statement>statement);
        }
        return Statement.createSwitchCase(null, statements, tn.range(startPos, tn.pos));
      } else
        this.error(DiagnosticCode._0_expected, tn.range(), ":");

    } else
      this.error(DiagnosticCode._case_or_default_expected, tn.range());

    return null;
  }

  parseThrowStatement(tn: Tokenizer): ThrowStatement | null {
    // at 'throw': Expression ';'?
    const startPos: i32 = tn.tokenPos;
    const expression: Expression | null = this.parseExpression(tn);
    if (!expression)
      return null;
    const ret: ThrowStatement = Statement.createThrow(<Expression>expression, tn.range(startPos, tn.pos));
    tn.skip(Token.SEMICOLON);
    return ret;
  }

  parseTryStatement(tn: Tokenizer): TryStatement | null {
    // at 'try': '{' Statement* '}' ('catch' '(' VariableMember ')' '{' Statement* '}')? ('finally' '{' Statement* '}'? ';'?
    const startRange: Range = tn.range();
    if (tn.skip(Token.OPENBRACE)) {
      const statements: Statement[] = new Array();
      while (!tn.skip(Token.CLOSEBRACE)) {
        const stmt: Statement | null = this.parseStatement(tn);
        if (!stmt)
          return null;
        statements.push(<Statement>stmt);
      }
      let catchVariable: IdentifierExpression | null = null;
      let catchStatements: Statement[] | null = null;
      let finallyStatements: Statement[] | null = null;
      if (tn.skip(Token.CATCH)) {
        if (!tn.skip(Token.OPENPAREN)) {
          this.error(DiagnosticCode._0_expected, tn.range(), "(");
          return null;
        }
        if (!tn.skip(Token.IDENTIFIER)) {
          this.error(DiagnosticCode.Identifier_expected, tn.range());
          return null;
        }
        catchVariable = Expression.createIdentifier(tn.readIdentifier(), tn.range());
        if (!tn.skip(Token.CLOSEPAREN)) {
          this.error(DiagnosticCode._0_expected, tn.range(), ")");
          return null;
        }
        if (!tn.skip(Token.OPENBRACE)) {
          this.error(DiagnosticCode._0_expected, tn.range(), "{");
          return null;
        }
        catchStatements = new Array();
        while (!tn.skip(Token.CLOSEBRACE)) {
          const stmt: Statement | null = this.parseStatement(tn);
          if (!stmt)
            return null;
          catchStatements.push(<Statement>stmt);
        }
      }
      if (tn.skip(Token.FINALLY)) {
        if (!tn.skip(Token.OPENBRACE)) {
          this.error(DiagnosticCode._0_expected, tn.range(), "{");
          return null;
        }
        finallyStatements = new Array();
        while (!tn.skip(Token.CLOSEBRACE)) {
          const stmt: Statement | null = this.parseStatement(tn);
          if (!stmt)
            return null;
          finallyStatements.push(<Statement>stmt);
        }
      }
      if (!(catchStatements || finallyStatements)) {
        this.error(DiagnosticCode._0_expected, tn.range(), "catch");
        return null;
      }
      const ret: TryStatement = Statement.createTry(statements, catchVariable, catchStatements, finallyStatements, Range.join(startRange, tn.range()));
      tn.skip(Token.SEMICOLON);
      return ret;
    } else
      this.error(DiagnosticCode._0_expected, tn.range(), "{");
    return null;
  }

  parseWhileStatement(tn: Tokenizer): WhileStatement | null {
    // at 'while': '(' Expression ')' Statement ';'?
    const startRange: Range = tn.range();
    if (tn.skip(Token.OPENPAREN)) {
      const expression: Expression | null = this.parseExpression(tn);
      if (!expression)
        return null;
      if (tn.skip(Token.CLOSEPAREN)) {
        const statement: Statement | null = this.parseStatement(tn);
        if (!statement)
          return null;
        const ret: WhileStatement = Statement.createWhile(<Expression>expression, <Statement>statement, Range.join(startRange, tn.range()));
        tn.skip(Token.SEMICOLON);
        return ret;
      } else
        this.error(DiagnosticCode._0_expected, tn.range(), ")");
    } else
      this.error(DiagnosticCode._0_expected, tn.range(), "(");
    return null;
  }

  // expressions
  // see: http://www.engr.mun.ca/~theo/Misc/exp_parsing.htm#climbing

  parseExpressionPrefix(tn: Tokenizer): Expression | null {
    const token: Token = tn.next();
    const startPos: i32 = tn.tokenPos;

    if (token == Token.NULL)
      return Expression.createNull(tn.range());
    if (token == Token.TRUE)
      return Expression.createTrue(tn.range());
    if (token == Token.FALSE)
      return Expression.createFalse(tn.range());

    let p: Precedence = determinePrecedencePrefix(token);
    if (p != Precedence.INVALID) {
      const operand: Expression | null = this.parseExpression(tn, p);
      if (!operand)
        return null;

      // TODO: SpreadExpression, YieldExpression (currently become unsupported UnaryPrefixExpressions)

      // NewExpression
      if (token == Token.NEW) {
        if (operand.kind == NodeKind.IDENTIFIER || operand.kind == NodeKind.PROPERTYACCESS) {
          const args: Expression[] = new Array();
          if (tn.skip(Token.OPENPAREN)) {
            if (tn.peek() != Token.CLOSEPAREN) {
              do {
                const expr: Expression | null = this.parseExpression(tn, Precedence.COMMA + 1);
                if (!expr)
                  return null;
                args.push(<Expression>expr);
              } while (tn.skip(Token.COMMA));
            }
            if (!tn.skip(Token.CLOSEPAREN)) {
              this.error(DiagnosticCode._0_expected, tn.range(), ")");
              return null;
            }
          }
          return Expression.createNew(operand, [], args, tn.range(startPos, tn.pos));
        } else {
          this.error(DiagnosticCode.Identifier_expected, tn.range());
          return null;
        }
      }

      // UnaryPrefixExpression
      if (token == Token.PLUS_PLUS || token == Token.MINUS_MINUS)
        if ((<Expression>operand).kind != NodeKind.IDENTIFIER && (<Expression>operand).kind != NodeKind.ELEMENTACCESS && (<Expression>operand).kind != NodeKind.PROPERTYACCESS)
          this.error(DiagnosticCode.The_operand_of_an_increment_or_decrement_operator_must_be_a_variable_or_a_property_access, (<Expression>operand).range);
      return Expression.createUnaryPrefix(token, <Expression>operand, tn.range(startPos, tn.pos));
    }

    switch (token) {

      // ParenthesizedExpression
      case Token.OPENPAREN: {
        const expr: Expression | null = this.parseExpression(tn);
        if (!expr)
          return null;
        if (!tn.skip(Token.CLOSEPAREN)) {
          this.error(DiagnosticCode._0_expected, tn.range(), ")");
          return null;
        }
        return Expression.createParenthesized(expr, tn.range(startPos, tn.pos));
      }

      // ArrayLiteralExpression
      case Token.OPENBRACKET: {
        const elementExpressions: (Expression | null)[] = new Array();
        if (!tn.skip(Token.CLOSEBRACKET)) {
          do {
            let expr: Expression | null;
            if (tn.peek() == Token.COMMA || tn.peek() == Token.CLOSEBRACKET)
              expr = null; // omitted
            else {
              expr = this.parseExpression(tn, Precedence.COMMA + 1);
              if (!expr)
                return null;
            }
            elementExpressions.push(expr);
          } while (tn.skip(Token.COMMA));
          if (!tn.skip(Token.CLOSEBRACKET)) {
            this.error(DiagnosticCode._0_expected, tn.range(), "]");
            return null;
          }
        }
        return Expression.createArrayLiteral(elementExpressions, tn.range(startPos, tn.pos));
      }

      // AssertionExpression (unary prefix)
      case Token.LESSTHAN: {
        const toType: TypeNode | null = this.parseType(tn);
        if (!toType)
          return null;
        if (!tn.skip(Token.GREATERTHAN)) {
          this.error(DiagnosticCode._0_expected, tn.range(), ">");
          return null;
        }
        const expr: Expression | null = this.parseExpressionPrefix(tn);
        if (!expr)
          return null;
        return Expression.createAssertion(AssertionKind.PREFIX, <Expression>expr, <TypeNode>toType, tn.range(startPos, tn.pos));
      }

      // IdentifierExpression
      case Token.IDENTIFIER:
        return Expression.createIdentifier(tn.readIdentifier(), tn.range(startPos, tn.pos));

      // StringLiteralExpression
      case Token.STRINGLITERAL:
        return Expression.createStringLiteral(tn.readString(), tn.range(startPos, tn.pos));

      // IntegerLiteralExpression
      case Token.INTEGERLITERAL:
        return Expression.createIntegerLiteral(tn.readInteger(), tn.range(startPos, tn.pos));

      // FloatLiteralExpression
      case Token.FLOATLITERAL:
        return Expression.createFloatLiteral(tn.readFloat(), tn.range(startPos, tn.pos));

      // RegexpLiteralExpression
      case Token.REGEXPLITERAL:
        return Expression.createRegexpLiteral(tn.readRegexp(), tn.range(startPos, tn.pos));

      default:
        this.error(DiagnosticCode.Expression_expected, tn.range());
        return null;
    }
  }

  tryParseTypeArgumentsBeforeArguments(tn: Tokenizer): TypeNode[] | null {
    // at '<': Identifier (',' Identifier)* '>' '('
    tn.mark();
    if (!tn.skip(Token.LESSTHAN))
      return null;

    const typeArguments: TypeNode[] = [];
    do {
      const type: TypeNode | null = this.parseType(tn);
      if (!type) {
        tn.reset();
        return null;
      }
      typeArguments.push(type);
    } while (tn.skip(Token.COMMA));
    if (!(tn.skip(Token.GREATERTHAN) && tn.skip(Token.OPENPAREN))) {
      tn.reset();
      return null;
    }
    return typeArguments;
  }

  parseArguments(tn: Tokenizer): Expression[] | null {
    // at '(': (Expression (',' Expression)*)? ')'
    const args: Expression[] = new Array();
    if (!tn.skip(Token.CLOSEPAREN)) {
      do {
        const expr: Expression | null = this.parseExpression(tn, Precedence.COMMA + 1);
        if (!expr)
          return null;
        args.push(<Expression>expr);
      } while (tn.skip(Token.COMMA));
      if (!tn.skip(Token.CLOSEPAREN)) {
        this.error(DiagnosticCode._0_expected, tn.range(), ")");
        return null;
      }
    }
    return args;
  }

  parseExpression(tn: Tokenizer, precedence: Precedence = 0): Expression | null {
    let expr: Expression | null = this.parseExpressionPrefix(tn);
    if (!expr)
      return null;

    const startPos: i32 = expr.range.start;

    // CallExpression
    const typeArguments: TypeNode[] | null = this.tryParseTypeArgumentsBeforeArguments(tn);
    // there might be better ways to distinguish a LESSTHAN from a CALL with type arguments
    if (typeArguments || tn.skip(Token.OPENPAREN)) {
      const args: Expression[] | null = this.parseArguments(tn);
      if (!args)
        return null;
      expr = Expression.createCall(expr, <TypeNode[]>(typeArguments ? typeArguments : []), args, tn.range(startPos, tn.pos));
    }

    let token: Token;
    let next: Expression | null = null;
    let nextPrecedence: Precedence;

    while ((nextPrecedence = determinePrecedence(token = tn.peek())) >= precedence) { // precedence climbing
      tn.next();

      // AssertionExpression
      if (token == Token.AS) {
        const toType: TypeNode | null = this.parseType(tn);
        if (!toType)
          return null;
        expr = Expression.createAssertion(AssertionKind.AS, expr, toType, tn.range(startPos, tn.pos));

      // ElementAccessExpression
      } else if (token == Token.OPENBRACKET) {
        next = this.parseExpression(tn); // resets precedence
        if (!next)
          return null;

        if (tn.skip(Token.CLOSEBRACKET))
          expr = Expression.createElementAccess(<Expression>expr, <Expression>next, tn.range(startPos, tn.pos));
        else {
          this.error(DiagnosticCode._0_expected, tn.range(), "]");
          return null;
        }

      // UnaryPostfixExpression
      } else if (token == Token.PLUS_PLUS || token == Token.MINUS_MINUS) {
        if (expr.kind != NodeKind.IDENTIFIER && expr.kind != NodeKind.ELEMENTACCESS && expr.kind != NodeKind.PROPERTYACCESS)
          this.error(DiagnosticCode.The_operand_of_an_increment_or_decrement_operator_must_be_a_variable_or_a_property_access, expr.range);
        expr = Expression.createUnaryPostfix(token, expr, tn.range(startPos, tn.pos));

      // SelectExpression
      } else if (token == Token.QUESTION) {
        const ifThen: Expression | null = this.parseExpression(tn);
        if (!ifThen)
          return null;
        if (tn.skip(Token.COLON)) {
          const ifElse: Expression | null = this.parseExpression(tn);
          if (!ifElse)
            return null;
          expr = Expression.createSelect(<Expression>expr, <Expression>ifThen, <Expression>ifElse, tn.range(startPos, tn.pos));
        } else {
          this.error(DiagnosticCode._0_expected, tn.range(), ":");
          return null;
        }

      } else {
        next = this.parseExpression(tn, isRightAssociative(token) ? nextPrecedence : 1 + nextPrecedence);
        if (!next)
          return null;

        // PropertyAccessExpression
        if (token == Token.DOT) {
          if (next.kind == NodeKind.IDENTIFIER) {
            expr = Expression.createPropertyAccess(<Expression>expr, <IdentifierExpression>next, tn.range(startPos, tn.pos));
          } else {
            this.error(DiagnosticCode.Identifier_expected, next.range);
            return null;
          }

        // BinaryExpression
        } else
          expr = Expression.createBinary(token, <Expression>expr, <Expression>next, tn.range(startPos, tn.pos));
      }
    }
    return expr;
  }
}

enum Precedence {
  COMMA,
  SPREAD,
  YIELD,
  ASSIGNMENT,
  CONDITIONAL,
  LOGICAL_OR,
  LOGICAL_AND,
  BITWISE_OR,
  BITWISE_XOR,
  BITWISE_AND,
  EQUALITY,
  RELATIONAL,
  SHIFT,
  ADDITIVE,
  MULTIPLICATIVE,
  EXPONENTIATED,
  UNARY_PREFIX,
  UNARY_POSTFIX,
  CALL,
  MEMBERACCESS,
  GROUPING,
  INVALID = -1
}

function determinePrecedencePrefix(kind: Token): i32 {
  switch (kind) {

    case Token.DOT_DOT_DOT:
      return Precedence.SPREAD;

    case Token.YIELD:
      return Precedence.YIELD;

    case Token.EXCLAMATION:
    case Token.TILDE:
    case Token.PLUS:
    case Token.MINUS:
    case Token.PLUS_PLUS:
    case Token.MINUS_MINUS:
    case Token.TYPEOF:
    case Token.VOID:
    case Token.DELETE:
      return Precedence.UNARY_PREFIX;

    case Token.NEW:
      return Precedence.MEMBERACCESS;

    default:
      return Precedence.INVALID;
  }
}

function determinePrecedence(kind: Token): i32 { // non-prefix
  switch (kind) {

    case Token.COMMA:
      return Precedence.COMMA;

    case Token.EQUALS:
    case Token.PLUS_EQUALS:
    case Token.MINUS_EQUALS:
    case Token.ASTERISK_ASTERISK_EQUALS:
    case Token.ASTERISK_EQUALS:
    case Token.SLASH_EQUALS:
    case Token.PERCENT_EQUALS:
    case Token.LESSTHAN_LESSTHAN_EQUALS:
    case Token.GREATERTHAN_GREATERTHAN_EQUALS:
    case Token.GREATERTHAN_GREATERTHAN_GREATERTHAN_EQUALS:
    case Token.AMPERSAND_EQUALS:
    case Token.CARET_EQUALS:
    case Token.BAR_EQUALS:
      return Precedence.ASSIGNMENT;

    case Token.QUESTION:
      return Precedence.CONDITIONAL;

    case Token.BAR_BAR:
      return Precedence.LOGICAL_OR;

    case Token.AMPERSAND_AMPERSAND:
      return Precedence.LOGICAL_AND;

    case Token.BAR:
      return Precedence.BITWISE_OR;

    case Token.CARET:
      return Precedence.BITWISE_XOR;

    case Token.AMPERSAND:
      return Precedence.BITWISE_AND;

    case Token.EQUALS_EQUALS:
    case Token.EXCLAMATION_EQUALS:
    case Token.EQUALS_EQUALS_EQUALS:
    case Token.EXCLAMATION_EQUALS_EQUALS:
      return Precedence.EQUALITY;

    case Token.AS:
    case Token.IN:
    case Token.INSTANCEOF:
    case Token.LESSTHAN:
    case Token.GREATERTHAN:
    case Token.LESSTHAN_EQUALS:
    case Token.GREATERTHAN_EQUALS:
      return Precedence.RELATIONAL;

    case Token.LESSTHAN_LESSTHAN:
    case Token.GREATERTHAN_GREATERTHAN:
    case Token.GREATERTHAN_GREATERTHAN_GREATERTHAN:
      return Precedence.SHIFT;

    case Token.PLUS:
    case Token.MINUS:
      return Precedence.ADDITIVE;

    case Token.ASTERISK:
    case Token.SLASH:
    case Token.PERCENT:
      return Precedence.MULTIPLICATIVE;

    case Token.ASTERISK_ASTERISK:
      return Precedence.EXPONENTIATED;

    case Token.PLUS_PLUS:
    case Token.MINUS_MINUS:
      return Precedence.UNARY_POSTFIX;

    case Token.DOT:
    case Token.NEW:
      return Precedence.MEMBERACCESS;

    default:
      return Precedence.INVALID;
  }
}

function isRightAssociative(kind: Token): bool { // non-prefix
  switch (kind) {

    case Token.EQUALS:
    case Token.PLUS_EQUALS:
    case Token.MINUS_EQUALS:
    case Token.ASTERISK_ASTERISK_EQUALS:
    case Token.ASTERISK_EQUALS:
    case Token.SLASH_EQUALS:
    case Token.PERCENT_EQUALS:
    case Token.LESSTHAN_LESSTHAN_EQUALS:
    case Token.GREATERTHAN_GREATERTHAN_EQUALS:
    case Token.GREATERTHAN_GREATERTHAN_GREATERTHAN_EQUALS:
    case Token.AMPERSAND_EQUALS:
    case Token.CARET_EQUALS:
    case Token.BAR_EQUALS:
    case Token.QUESTION:
    case Token.ASTERISK_ASTERISK:
      return true;

    default:
      return false;
  }
}

let reusableModifiers: Modifier[] | null = null;

function createModifiers(): Modifier[] {
  let ret: Modifier[];
  if (reusableModifiers != null) {
    ret = reusableModifiers;
    reusableModifiers = null;
  } else
    ret = new Array(1);
  ret.length = 0;
  return ret;
}

function addModifier(modifier: Modifier, modifiers: Modifier[] | null): Modifier[] {
  if (modifiers == null)
    modifiers = createModifiers();
  modifiers.push(modifier);
  return modifiers;
}

function getModifier(kind: ModifierKind, modifiers: Modifier[]): Modifier {
  for (let i: i32 = 0, k: i32 = modifiers.length; i < k; ++i)
    if (modifiers[i].modifierKind == kind)
      return modifiers[i];
  throw new Error("no such modifier");
}
