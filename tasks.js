//@ts-check
const { start, r } = require("./out/index")
const osLocale = require("os-locale")

start(async () => {
    process.env.LANG = ""
    const locale = await osLocale()

    const compile = r`tsc --project . --locale ${locale}`
    const test = compile
    const prepublishOnly = test
    return {
        prepublishOnly,
        test,
        watch: r`tsc --watch --project . --locale ${locale}`
    }
})
