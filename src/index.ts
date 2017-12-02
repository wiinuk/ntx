import * as childProcess from "child_process"
import * as path from "path"
import * as osLocale from "os-locale"
import * as fs from "fs"


export interface TaskEnvironment {
    readonly name: string
}
export interface Task<T> {
    readonly name: string | null
    withName(name: string | null): Task<T>
    run(env: TaskEnvironment): Promise<T>

    then<U>(this: Task<void>, continuation: Task<U>): Task<U>
    let<U>(continuation: (value: T) => Task<U>): Task<U>
    watch(this: Task<void>, fileName: string): Task<never>

    start(this: Task<void>): void
}

//#region utils

const changeExtension = (fileName: string, newExtension: string) => {
    const { dir, name } = path.parse(fileName)
    const e = (newExtension.indexOf(".") !== 0) ? ("." + newExtension) : newExtension
    return path.join(dir, name + e)
}

const execAsync = async (command: string) => {
    const p = new Promise<{ stdout: string, stderr: string }>((resolve, reject) => {
        childProcess.exec(command, (error, stdout, stderr) =>
            (error != null) ? reject(error) : resolve({ stdout, stderr })
        )
    })
    return p
}

class ProcessExitCodeError extends Error {
    constructor(readonly code: number, readonly signal: string) {
        super(`Process exited with non-zero code. code: ${code}, signal: ${signal}`)
    }
}
const spawnAsync = (command: string, args: string[], onOutputReceived: ((data: string | Buffer) => void) | null, onErrorReceived: ((data: string | Buffer) => void) | null) => {
    return new Promise<void>((resolve, reject) => {
        const p = childProcess.spawn(command, args, { shell: true })
        if (onErrorReceived != null) { p.stderr.on("data", onErrorReceived) }
        if (onOutputReceived != null) { p.stdout.on("data", onOutputReceived) }

        p.on("close", (code, signal) => {
            p.removeAllListeners()
            if (code !== 0) { reject(new ProcessExitCodeError(code, signal)) }
            else { resolve() }
        })
        p.on("error", error => {
            p.removeAllListeners()
            reject(error)
        })
    })
}
const npmBinPath = execAsync("npm bin").then(r => r.stdout.trim())

//#endregion

//#region task

const combineName = (env: TaskEnvironment, name: string | null) =>
    name ? { ...env, name: `${env.name}.${name}` } : env

class TaskImpl<T> implements Task<T> {
    constructor(
        readonly name: string | null,
        readonly run: (env: TaskEnvironment) => Promise<T>
    ) { }

    withName(name: string | null) { return new TaskImpl(name, this.run) }

    then<U>(this: Task<void>, continuation: Task<U>): Task<U> {
        return new TaskImpl(this.name, async e => {
            await this.run(combineName(e, this.name))
            return continuation.run(combineName(e, continuation.name))
        })
    }

    let<U>(continuation: (value: T) => Task<U>): Task<U> {
        return toTask(async e => {
            const t = continuation(await this.run(combineName(e, this.name)))
            return t.run(combineName(e, t.name))
        })
    }

    watch(this: Task<void>, fileName: string): Task<never> {
        return new TaskImpl(this.name, env => new Promise<never>((_, reject) => {
            let last = Promise.resolve()
            const w = fs.watch(fileName, { recursive: true }, () =>
                last = last.then(() => this.run(env))
            )
            w.once("error", reject)
        }))
    }

    start(this: Task<void>) {
        const name = this.name || "_"
        console.log(`> ${name} ${process.cwd()}`)
        handleError(this.run({ name }))
    }
}
export function all(tasks: Task<void>[]): Task<void>
export function all<T1, T2>(tasks: [Task<T1>, Task<T2>]): Task<[T1, T2]>
export function all<T1, T2, T3>(tasks: [Task<T1>, Task<T2>, Task<T3>]): Task<[T1, T2, T3]>
export function all<T1, T2, T3, T4>(tasks: [Task<T1>, Task<T2>, Task<T3>, Task<T4>]): Task<[T1, T2, T3, T4]>
export function all(tasks: Task<any>[]): Task<any> {
    const name1 = tasks[0].name
    return new TaskImpl(name1 === void 0 ? null : name1, env => {
        let es = tasks.map(t => combineName(env, t.name))
        if (new Set(es.map(e => e.name)).size !== es.length) {
            es = es.map((e, i) => ({ ...e, name: `${env.name}.${i + 1}` }))
        }
        return Promise.all(tasks.map((t, i) => t.run(es[i])))
    })
}

const toTask = <T>(run: (env: TaskEnvironment) => Promise<T>): Task<T> => new TaskImpl(null, run)
export const wrap = <T>(run: () => Promise<T>): Task<T> => toTask(() => run())

const overrideEnvAsync = async <T>(key: string, value: string, action: () => T) => {
    const oldValue = process.env[key]
    process.env[key] = value
    const result = await action()
    process.env[key] = oldValue
    return result
}

export const r = (strings: TemplateStringsArray, ...values: string[]) => toTask(async e => {
    const result = [strings[0]];
    for (let i = 0, l = values.length; i < l; i++) {
        result.push(values[i])
        result.push(strings[i + 1])
    }
    const name = e.name
    const command = result.join("")
    console.log(`${name}> ${command}`)
    return overrideEnvAsync("path", process.env.path + ";" + await npmBinPath, () =>
        spawnAsync(command, [],
            s => {
                process.stdout.write(`${name}> `)
                process.stdout.write(s)
            },
            s => {
                process.stderr.write(`${name}> `)
                process.stderr.write(s)
            }
        )
    )
})

type Tasks<T> = {[P in keyof T]: Task<void> } & object


const startAsync = async <T extends Tasks<T>>(makeTasks: () => Promise<T>) => {
    const tasks = await makeTasks()
    const taskName = process.argv[2]

    const taskNames = Object.keys(tasks)
    const getAvailableTasksMessage = (ks: string[]) => `available tasks: ${ks.map(k => `'${k}'`).join(" ")}`

    if (taskName === void 0) {
        const [name0] = taskNames
        const egName = (name0 == null || name0 == "") ? "any_task_name" : (/\w[\w:]*/.test(name0)) ? name0 : `'${name0}'`
        throw new Error(`require task name. e.g. \`node ${path.basename(process.argv[1])} ${egName}\`. ${getAvailableTasksMessage(taskNames)}.`)
    }
    if (taskNames.indexOf(taskName) === -1) { throw new Error(`task '${taskName}' is not defined. ${getAvailableTasksMessage(taskNames)}.`) }

    const task: Task<void> = tasks[taskName as keyof T]
    return task.withName(taskName).start()
}
const handleError = (p: Promise<void>) => { p.catch(e => console.error(e)) }

export const start = <T extends Tasks<T>>(makeTasks: () => Promise<T>) => handleError(startAsync(makeTasks))

//#endregion

//#region self building

export const _build = () => toTask(async () => overrideEnvAsync("LANG", "", osLocale))
    .let(locale => r`tsc ${changeExtension(__filename, ".ts")} --declaration --lib ES6 --target ES6 --module commonjs --locale ${locale}`)
    .withName("buildSelf")
    .start()

//#endregion
