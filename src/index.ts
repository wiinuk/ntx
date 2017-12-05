import * as childProcess from "child_process"
import * as path from "path"
import * as chokidar from "chokidar"


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

const execAsync = async (command: string) => {
    const p = new Promise<{ stdout: string, stderr: string }>((resolve, reject) => {
        childProcess.exec(command, (error, stdout, stderr) =>
            (error != null) ? reject(error) : resolve({ stdout, stderr })
        )
    })
    return p
}

export class ProcessExitCodeError extends Error {
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

    watch(this: Task<void>, glob: string | string[]): Task<never> {
        return new TaskImpl(this.name, env => new Promise<never>((_resolve, reject) => {
            let last = Promise.resolve()
            const w = chokidar.watch(glob, { persistent: true })
            w.once("error", e => {
                w.removeAllListeners()
                w.close()
                reject(e)
            })
            w.on("all", (_event, _path) => {
                last = last.then(() => this.run(env)).catch(reject)
            })
        }))
    }

    start(this: Task<void>) {
        const name = this.name || "_"
        console.log(`> ${name} ${process.cwd()}`)
        handleError(this.run({ name }))
    }
}

const allArray = <T>(tasks: Task<T>[]): Task<T[]> => {
    const name1 = tasks[0].name
    return new TaskImpl(name1 === void 0 ? null : name1, env => {
        let es = tasks.map(t => combineName(env, t.name))
        if (new Set(es.map(e => e.name)).size !== es.length) {
            es = es.map((e, i) => ({ ...e, name: `${env.name}.${i + 1}` }))
        }
        return Promise.all(tasks.map((t, i) => t.run(es[i])))
    })
}

export { all }

function all(tasks: Task<void>[]): Task<void>
function all<T1, T2>(tasks: [Task<T1>, Task<T2>]): Task<[T1, T2]>
function all<T1, T2, T3>(tasks: [Task<T1>, Task<T2>, Task<T3>]): Task<[T1, T2, T3]>
function all<T1, T2, T3, T4>(tasks: [Task<T1>, Task<T2>, Task<T3>, Task<T4>]): Task<[T1, T2, T3, T4]>
function all<T>(tasks: Task<T>[]): Task<T[]>

function all(...tasks: Task<void>[]): Task<void>
function all<T1, T2>(task1: Task<T1>, task2: Task<T2>): Task<[T1, T2]>
function all<T1, T2, T3>(task1: Task<T1>, task2: Task<T2>, task3: Task<T3>): Task<[T1, T2, T3]>
function all<T1, T2, T3, T4>(task1: Task<T1>, task2: Task<T2>, task3: Task<T3>, task4: Task<T4>): Task<[T1, T2, T3, T4]>
function all<T>(...tasks: Task<T>[]): Task<T[]>

function all<T>(taskArrayOrTask1: Task<T>[] | Task<T>, ...tasksTail: Task<T>[]): Task<any> {
    if (Array.isArray(taskArrayOrTask1)) {
        return allArray(taskArrayOrTask1)
    }
    else {
        tasksTail.unshift(taskArrayOrTask1)
        return allArray(tasksTail)
    }
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

export const r = (strings: TemplateStringsArray, ...stringsOrTasksOrPromises: (string | Task<string> | Promise<string>)[]) => toTask(async e => {
    const xs = [strings[0]];
    for (let i = 0, l = stringsOrTasksOrPromises.length; i < l; i++) {
        const v = stringsOrTasksOrPromises[i]
        const s =
            (typeof v === "string") ? v :
            (v instanceof Promise) ? await v :
            await v.run(e)
            
        xs.push(s)
        xs.push(strings[i + 1])
    }
    const name = e.name
    const command = xs.join("")
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


const startAsync = async <T extends Tasks<T>>(tasksOrFunction: T | (() => Promise<T>)) => {
    const tasks = (typeof tasksOrFunction === "function") ? await tasksOrFunction() : tasksOrFunction

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

export const start = <T extends Tasks<T>>(tasksOrFunction: T | (() => Promise<T>)) => handleError(startAsync(tasksOrFunction))

//#endregion
