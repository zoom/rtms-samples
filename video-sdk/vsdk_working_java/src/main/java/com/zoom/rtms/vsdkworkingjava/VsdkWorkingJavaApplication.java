package com.zoom.rtms.vsdkworkingjava;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.PropertySource;
import org.springframework.scheduling.annotation.EnableAsync;

@SpringBootApplication
@EnableAsync
@PropertySource(value = "file:.env", ignoreResourceNotFound = true)
public class VsdkWorkingJavaApplication {

    public static void main(String[] args) {
        SpringApplication.run(VsdkWorkingJavaApplication.class, args);
    }
}
