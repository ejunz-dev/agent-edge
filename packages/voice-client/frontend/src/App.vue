<template>
    <n-config-provider :theme="osTheme === 'dark' ? darkTheme : undefined">
        <n-notification-provider>
            <voice-test />
        </n-notification-provider>
    </n-config-provider>
</template>

<script setup lang="ts">
import { darkTheme, useOsTheme } from 'naive-ui';
import VoiceTest from './components/VoiceTest.vue';

const osTheme = useOsTheme();
</script>

