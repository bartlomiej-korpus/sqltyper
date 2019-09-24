import * as path from 'path'

import * as Either from 'fp-ts/lib/Either'
import * as Task from 'fp-ts/lib/Task'
import { pipe } from 'fp-ts/lib/pipeable'

import { sequenceATs } from './fp-utils'
import { TypeClient } from './tstype'
import { StatementDescription, NamedValue } from './types'

////////////////////////////////////////////////////////////////////////

export function validateStatement(
  stmt: StatementDescription
): Either.Either<string, StatementDescription> {
  const columnNames: Set<string> = new Set()
  const conflicts: Set<string> = new Set()

  stmt.columns.forEach(({ name }) => {
    if (columnNames.has(name)) {
      conflicts.add(name)
    } else {
      columnNames.add(name)
    }
  })

  if (conflicts.size) {
    const dup = [...conflicts.values()].sort().join(', ')
    return Either.left(`Duplicate output columns: ${dup}`)
  }

  return Either.right(stmt)
}

////////////////////////////////////////////////////////////////////////

export function generateTypeScript(
  types: TypeClient,
  pgModule: string,
  funcName: string,
  stmt: StatementDescription
): Task.Task<string> {
  const positionalOnly = hasOnlyPositionalParams(stmt)
  return pipe(
    Task.of(typeScriptString(pgModule, funcName, stmt.sql)),
    Task.ap(funcParams(types, stmt, positionalOnly)),
    Task.ap(funcReturnType(types, stmt)),
    Task.ap(Task.of(queryValues(stmt, positionalOnly))),
    Task.ap(Task.of(outputValue(stmt)))
  )
}

const typeScriptString = (pgModule: string, funcName: string, sql: string) => (
  params: string
) => (returnType: string) => (queryValues: string) => (
  outputValue: string
): string => `\
import { ClientBase } from '${pgModule}'

export async function ${funcName}(
  client: ClientBase${params}
): Promise<${returnType}> {
    const result = await client.query(\`\\
${sql}\`${queryValues})
    return ${outputValue}
}
`

function hasOnlyPositionalParams(stmt: StatementDescription) {
  return stmt.params.every(param => !!param.name.match(/\$\d+/))
}

function funcReturnType(
  types: TypeClient,
  stmt: StatementDescription
): Task.Task<string> {
  return pipe(
    stmt.columns.map(columnType(types)),
    sequenceATs,
    Task.map(columnTypes => {
      const rowType = '{ ' + columnTypes.join('; ') + ' }'
      switch (stmt.rowCount) {
        case 'zero':
          return 'number' // return the affected row count
        case 'one':
          return rowType
        case 'zeroOrOne':
          return `${rowType} | null`
        case 'many':
          return `Array<${rowType}>`
      }
    })
  )
}

const columnType = (types: TypeClient) => (
  column: NamedValue
): Task.Task<string> => {
  return pipe(
    types.columnType(column),
    Task.map(({ name, type }) => `${stringLiteral(name)}: ${type}`)
  )
}

function outputValue(stmt: StatementDescription): string {
  switch (stmt.rowCount) {
    case 'zero':
      return 'result.rowCount' // return the affected row count
    case 'one':
      return 'result.rows[0]'
    case 'zeroOrOne':
      return 'result.rows.length ? result.rows[0] : null'
    case 'many':
      return 'result.rows'
  }
}

function stringLiteral(str: string): string {
  return "'" + str.replace('\\', '\\\\').replace("'", "\\'") + "'"
}

function funcParams(
  types: TypeClient,
  stmt: StatementDescription,
  positionalOnly: boolean
): Task.Task<string> {
  if (!stmt.params.length) {
    return Task.of('')
  }

  return pipe(
    positionalOnly
      ? positionalFuncParams(types, stmt)
      : namedFuncParams(types, stmt),
    Task.map(params => `, ${params}`)
  )
}

function positionalFuncParams(
  types: TypeClient,
  stmt: StatementDescription
): Task.Task<string> {
  return pipe(
    stmt.params.map(param =>
      pipe(
        types.tsType(param.type, param.nullable),
        Task.map(tsType => `${param.name}: ${tsType}`)
      )
    ),
    sequenceATs,
    Task.map(params => params.join(', '))
  )
}

function namedFuncParams(
  types: TypeClient,
  stmt: StatementDescription
): Task.Task<string> {
  return pipe(
    positionalFuncParams(types, stmt),
    Task.map(params => `params: { ${params} }`)
  )
}

function queryValues(
  stmt: StatementDescription,
  positionalOnly: boolean
): string {
  if (!stmt.params.length) {
    return ''
  }

  const prefix = positionalOnly ? '' : 'params.'
  return (
    ', [ ' + stmt.params.map(param => prefix + param.name).join(', ') + ' ]'
  )
}

////////////////////////////////////////////////////////////////////////

export type TsModule = {
  sqlFileName: string
  tsFileName: string
  funcName: string
}

export type TsModuleDir = {
  dirPath: string
  modules: TsModule[]
}

export function generateIndexModule(modules: TsModule[]): string {
  return modules
    .map(
      ({ tsFileName, funcName }) =>
        `export { ${funcName} } from './${baseNameWithoutExt(tsFileName)}';`
    )
    .join('\n')
}

function baseNameWithoutExt(filePath: string): string {
  return path.parse(filePath).name
}
