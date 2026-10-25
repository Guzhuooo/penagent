# Structural sanity check only. This is NOT a target ABI/import compatibility
# verdict. tools/native-ci.py performs the mandatory exact supplied-export audit
# after build and before staging any uploadable artifact.
foreach(required IN ITEMS HTTPX_ARTIFACT HTTPX_NM HTTPX_READELF HTTPX_CURL_LIBRARY)
    if(NOT DEFINED ${required} OR "${${required}}" STREQUAL "")
        message(FATAL_ERROR "Missing ${required} for httpx ELF sanity check")
    endif()
endforeach()
execute_process(COMMAND "${HTTPX_READELF}" -h -l -d --version-info "${HTTPX_ARTIFACT}"
    OUTPUT_VARIABLE elf ERROR_VARIABLE hidden_error RESULT_VARIABLE result)
if(NOT result EQUAL 0 OR NOT elf MATCHES "Class:[ \t]+ELF64" OR
   NOT elf MATCHES "Data:[^\n]*little endian" OR NOT elf MATCHES "Machine:[ \t]+AArch64" OR
   NOT elf MATCHES "Type:[ \t]+DYN" OR
   NOT elf MATCHES "NEEDED[^\n]*\\[libcurl\\.so\\.4\\]")
    message(FATAL_ERROR "httpx must be ELF64 little-endian AArch64 DYN with libcurl.so.4")
endif()
if(elf MATCHES "(RPATH|RUNPATH|TEXTREL|INTERP)")
    message(FATAL_ERROR "httpx must not embed search paths, text relocations or PT_INTERP")
endif()
execute_process(COMMAND "${HTTPX_NM}" -D -P --defined-only "${HTTPX_ARTIFACT}"
    OUTPUT_VARIABLE defined ERROR_VARIABLE hidden_error RESULT_VARIABLE result)
if(NOT result EQUAL 0 OR NOT defined MATCHES "(^|\n)custom_init_jsapis T ")
    message(FATAL_ERROR "Missing exported custom_init_jsapis entry point")
endif()
message(STATUS "httpx ELF structure checked; exact target exports still require native-ci audit")
