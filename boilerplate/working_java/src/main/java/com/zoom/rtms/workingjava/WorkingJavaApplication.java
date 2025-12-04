package com.zoom.rtms.workingjava;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.PropertySource;
import org.springframework.scheduling.annotation.EnableAsync;

@SpringBootApplication
@EnableAsync
@PropertySource(value = "file:.env", ignoreResourceNotFound = true)
public class WorkingJavaApplication {

    public static void main(String[] args) {
        SpringApplication.run(WorkingJavaApplication.class, args);
    }
}
