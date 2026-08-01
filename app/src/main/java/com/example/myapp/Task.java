
package com.example.myapp;

public class Task {
    private String text;
    private boolean isCompleted;

    public Task(String text, boolean isCompleted) {
        this.text = text;
        this.isCompleted = isCompleted;
    }

    public String getText() { return text; }
    public boolean isCompleted() { return isCompleted; }
    public void setCompleted(boolean completed) { isCompleted = completed; }
}
