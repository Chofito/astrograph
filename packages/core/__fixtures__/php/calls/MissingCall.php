<?php

namespace App;

class MissingCall extends ParentService
{
    public function nope(): void
    {
        $this->doesNotExist();
    }
}
