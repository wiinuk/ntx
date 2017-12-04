//@ts-check
const { start, r } = require("./out/index")
const osLocale = require("os-locale")

process.env.LANG = ""
const locale = osLocale()

const watch = r`tsc --watch --project . --locale ${locale}`
const compile = r`tsc --project . --locale ${locale}`
const test = compile
const prepublishOnly = test

start({
    prepublishOnly,
    test,
    watch,
})
